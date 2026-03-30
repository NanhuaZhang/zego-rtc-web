const {TosClient}  = require('@volcengine/tos-sdk');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const { ZegoAIAgent } = require('./zegoAIAgent');
const { extractError, log, sanitizeForLog, withRequestContext } = require('./logger');
const {generateToken04} = require("./token");
const {createClient} = require("redis");

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const requestId = randomId('req_');
  withRequestContext({ requestId }, () => {
    req.requestId = requestId;
    req.requestStartAt = Date.now();
    res.setHeader('x-request-id', req.requestId);

    reqLog(req, 'log', 'http', 'request started', summarizeRequest(req));

    res.on('finish', () => {
      reqLog(req, 'log', 'http', 'request completed', {
        statusCode: res.statusCode,
        durationMs: Date.now() - req.requestStartAt,
      });
    });

    next();
  });
});

function randomId(prefix) {
  return prefix + Math.random().toString(36).substring(2, 10);
}

function summarizeRequest(req) {
  return sanitizeForLog({
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.method === 'GET' ? undefined : req.body,
  });
}

function reqLog(req, level, scope, message, data) {
  log(level, scope, message, data);
}

// 从环境变量获取配置
const appID = Number(process.env.NEXT_PUBLIC_ZEGO_APP_ID);
const serverSecret = process.env.ZEGO_SERVER_SECRET;

function createMemoryKVStore() {
  const memoryStore = new Map();

  return {
    mode: 'memory',
    async get(key) {
      return memoryStore.has(key) ? memoryStore.get(key) : null;
    },
    async set(key, value) {
      memoryStore.set(key, String(value));
    },
    async delete(key) {
      memoryStore.delete(key);
    },
  };
}

function createRedisKVStore(client) {
  return {
    mode: 'redis',
    async get(key) {
      return client.get(key);
    },
    async set(key, value) {
      await client.set(key, String(value));
    },
    async delete(key) {
      await client.del(key);
    },
  };
}

const memoryKVStore = createMemoryKVStore();
let kvStore = memoryKVStore;

async function initializeKVStore() {
  const redisMode = (process.env.REDIS_MODE || 'auto').toLowerCase();
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  if (redisMode === 'memory') {
    log('log', 'kv-store', 'using in-memory mock store by configuration', { redisMode });
    return;
  }

  const redisClient = createClient({
    url: redisUrl
  });
  redisClient.on('error', (err) => {
    log('error', 'kv-store', 'redis client error', extractError(err));
  });

  try {
    await redisClient.connect();
    kvStore = createRedisKVStore(redisClient);
    log('log', 'kv-store', 'connected to redis', { redisUrl });
  } catch (error) {
    if (redisMode === 'redis') {
      throw error;
    }
    log('warn', 'kv-store', 'redis unavailable, fallback to in-memory mock store', {
      redisUrl,
      error: extractError(error),
    });
  }
}

function hasTosConfig() {
  return Boolean(process.env.API_ACCESS_KEY && process.env.API_SECRET_KEY && process.env.TOS_REGION_ID);
}

let tosClient = null;

function getTosClient() {
  if (!hasTosConfig()) {
    return null;
  }

  if (!tosClient) {
    tosClient = new TosClient({
      accessKeyId: process.env.API_ACCESS_KEY,
      accessKeySecret: process.env.API_SECRET_KEY,
      region: process.env.TOS_REGION_ID, // 填写 Bucket 所在地域。以华北2（北京)为例，"Provide your region" 填写为 cn-beijing。
      endpoint: process.env.TOS_ENDPOINT_SINGLE, // 填写域名地址
    });
  }

  return tosClient;
}

/**
 * 检查 TOS 上的“文件夹”是否存在
 * @param {string} folderPath 文件夹路径，如 "path/to/folder"
 * @returns {Promise<boolean>} true 表示存在，false 表示不存在
 */
async function folderExists(folderPath) {
  const client = getTosClient();
  if (!client) {
    log('warn', 'tos', 'missing TOS config, skip folder existence check', { folderPath });
    return false;
  }

  // 确保以 "/" 结尾
  if (!folderPath.endsWith('/')) {
    folderPath += '/';
  }

  try {
    const res = await client.listObjectsType2({
      prefix: folderPath,
      maxKeys: 1,  // 只需要检查是否有对象
      bucket: process.env.TOS_BUCKET,
    });

    log('log', 'tos', 'folder existence checked', {
      folderPath,
      hasContent: res.data.Contents.length > 0,
    });
    return res.data.Contents.length > 0;
  } catch (err) {
    log('error', 'tos', 'folder existence check failed', {
      folderPath,
      error: extractError(err),
    });
    return false;
  }
}

function getRoomUsedKey(roomID) {
  return `room_used:${roomID}`;
}

function getRoomAgentKey(roomID) {
  return `room_agent:${roomID}`;
}

function getRoomConfigKey(roomID) {
  return `room_config:${roomID}`;
}

function getAgentMuteKey(agentInstanceId) {
  return `agent_mute:${agentInstanceId}`;
}

function normalizeAsrVendor(asrVendor) {
  if (!asrVendor) {
    return undefined;
  }

  if (String(asrVendor).trim().toLowerCase() === 'aliyunparaformer') {
    return 'AliyunParaformer';
  }

  return undefined;
}

function normalizeRoomConfig(roomConfig = {}) {
  return {
    isSingle: Boolean(roomConfig.isSingle),
    asrVendor: normalizeAsrVendor(roomConfig.asrVendor),
  };
}

async function isRoomUsedInRedis(roomID) {
  const used = await kvStore.get(getRoomUsedKey(roomID));
  return used === '1';
}

async function markRoomUsed(roomID) {
  await kvStore.set(getRoomUsedKey(roomID), '1');
}

async function getRoomAgentInstanceId(roomID) {
  return kvStore.get(getRoomAgentKey(roomID));
}

async function setRoomAgentInstanceId(roomID, agentInstanceId) {
  await kvStore.set(getRoomAgentKey(roomID), agentInstanceId);
}

async function getRoomConfig(roomID) {
  const config = await kvStore.get(getRoomConfigKey(roomID));
  if (!config) {
    return null;
  }

  try {
    return normalizeRoomConfig(JSON.parse(config));
  } catch (error) {
    log('error', 'room-config', 'failed to parse cached room config', {
      roomID,
      rawConfig: config,
      error: extractError(error),
    });
    return null;
  }
}

async function setRoomConfig(roomID, roomConfig) {
  await kvStore.set(getRoomConfigKey(roomID), JSON.stringify(normalizeRoomConfig(roomConfig)));
}

// ====== token 接口（返回静态 token）======
app.get('/token', (req, res) => {
  try {
    const { userId } = req.query;
    reqLog(req, 'log', 'token', 'token requested', { userId });

    // 验证必要参数
    if (!userId) {
      reqLog(req, 'warn', 'token', 'missing userId');
      return res.json(
          {
            code: 400,
            message: 'userId is required'
          },
          { status: 400 }
      );
    }

    if (!appID || !serverSecret) {
      reqLog(req, 'error', 'token', 'server configuration missing', {
        hasAppID: !!appID,
        hasServerSecret: !!serverSecret,
      });
      return res.json(
          {
            code: 500,
            message: 'Server configuration error'
          },
          { status: 500 }
      );
    }

    // 设置token有效期（1小时）
    const effectiveTimeInSeconds = 3600;
    reqLog(req, 'log', 'token', 'generating token', {
      appID,
      userId,
      effectiveTimeInSeconds,
    });

    // 生成token
    const token = generateToken04(
        appID,
        userId,
        serverSecret,
        effectiveTimeInSeconds,
        '' // payload为空字符串
    );

    // 返回token
    const response = {
      code: 0,
      message: 'Generate token success',
      token,
      user_id: userId,
      expire_time: Date.now() + effectiveTimeInSeconds * 1000
    };

    reqLog(req, 'log', 'token', 'token generated', {
      hasToken: !!token,
      userId,
      expireTime: response.expire_time,
    });

    return res.json(response);
  } catch (e) {
    reqLog(req, 'error', 'token', 'failed to generate token', extractError(e));
    return res.status(500).json({ code: 500, msg: '返回 token 失败' });
  }
});

// ====== Group Agent 接口（Create / Join）======
const agentName = '豆包';

app.post('/check', async (req, res) => {
  try {
    const {roomID} = req.body || {};
    if (!roomID) {
      reqLog(req, 'warn', 'check', 'missing roomID');
      return res.status(400).json({ code: 400, msg: '缺少 roomID' });
    }

    const [existRoomInRedis, existRoomInTos] = await Promise.all([
      isRoomUsedInRedis(roomID),
      folderExists(roomID),
    ]);
    const existRoom = existRoomInRedis || existRoomInTos;

    if (!existRoomInRedis && existRoomInTos) {
      await markRoomUsed(roomID);
    }

    reqLog(req, 'log', 'check', 'room usage checked', {
      roomID,
      existRoom,
      existRoomInRedis,
      existRoomInTos,
    });

    return res.json({
      code: 0,
      existRoom,
      existRoomInRedis,
      existRoomInTos,
    })
  }catch(e) {
    reqLog(req, 'error', 'check', 'room usage check failed', extractError(e));
    return res.status(500).json({ code: 500, msg: 'check 接口调用失败' });
  }
})

app.post('/interrupt', async (req, res) => {
  try {
    const {agentInstanceId} = req.body || {};
    const agent = ZegoAIAgent.getInstance();
    const result = await agent.interruptAgentInstance(agentInstanceId);
    reqLog(req, 'log', 'interrupt', 'agent instance interrupted', {
      agentInstanceId,
      hasResult: !!result,
    });
    return res.json({
      code: 0,
      result
    })
  }catch(e) {
    reqLog(req, 'error', 'interrupt', 'failed to interrupt agent instance', extractError(e));
    return res.status(500).json({ code: 500, msg: 'interrupt 接口调用失败' });
  }
})

app.post('/mute', async (req, res) => {
  try {
    const {isAgentMuted,agentInstanceId} = req.body || {};
    await kvStore.set(getAgentMuteKey(agentInstanceId), isAgentMuted ? 1 : 0);
    reqLog(req, 'log', 'mute', 'agent mute state updated', {
      agentInstanceId,
      isAgentMuted: !!isAgentMuted,
    });
    return res.json({
      code: 0,
    })
  }catch(e) {
    reqLog(req, 'error', 'mute', 'failed to update agent mute state', extractError(e));
    return res.status(500).json({ code: 500, msg: 'interrupt 接口调用失败' });
  }
})

// 前端只需要调用这个接口：服务器内部根据是否已经有实例自动选择 Create 或 Join
app.post('/group-agent/enter', async (req, res) => {
  try {
    const { roomID, userID, rtcInfo, asrVendor, isSingle } = req.body || {};
    if (!roomID || !userID) {
      reqLog(req, 'warn', 'group-agent', 'missing roomID or userID', { roomID, userID });
      return res.status(400).json({ code: 400, msg: '缺少 roomID 或 userID' });
    }

    const agent = ZegoAIAgent.getInstance();
    let agentInstanceId = await getRoomAgentInstanceId(roomID);
    let result;
    const requestedRoomConfig = normalizeRoomConfig({ asrVendor, isSingle });
    let roomConfig = await getRoomConfig(roomID);

    if (!roomConfig) {
      roomConfig = requestedRoomConfig;
      await setRoomConfig(roomID, roomConfig);
      reqLog(req, 'log', 'group-agent', 'room config locked', {
        roomID,
        roomConfig,
      });
    } else if (
      roomConfig.isSingle !== requestedRoomConfig.isSingle ||
      roomConfig.asrVendor !== requestedRoomConfig.asrVendor
    ) {
      reqLog(req, 'warn', 'group-agent', 'room config mismatch, using locked config', {
        roomID,
        requestedRoomConfig,
        roomConfig,
      });
    }

    const asrConfig = agent.buildAsrConfig(roomConfig.asrVendor);

    // 如果前端没有传 RTC 信息，这里根据房间做一个最简单的占位结构
    const rtc = {
      RoomId: roomID,
      AgentStreamId: rtcInfo.AgentStreamId || randomId('stream_agent_'),
      AgentUserId: randomId('ai_agent_'),
      UserStreamId: rtcInfo.UserStreamId,
    };

    if (!agentInstanceId) {
      reqLog(req, 'log', 'group-agent', 'creating group agent instance', {
        roomID,
        userID,
        agentUserId: rtc.AgentUserId,
        roomConfig,
      });
      await agent.ensureAgentRegistered(rtc.AgentUserId, agentName, asrConfig);
      // 第一个用户：创建 Group Agent 实例
      result = await agent.createGroupAgentInstance(
        rtc.AgentUserId,
        userID,
        rtc,
        null,
        null,
        asrConfig
      );
      // 从返回中推断 AgentInstanceId（字段名可按文档调整）
      agentInstanceId =
        (result && result.Data && (result.Data.AgentInstanceId || result.Data.AgentInstanceID)) ||
        result.AgentInstanceId ||
        null;
      if (agentInstanceId) {
        await setRoomAgentInstanceId(roomID, agentInstanceId);
      }
      reqLog(req, 'log', 'group-agent', 'group agent instance created', {
        roomID,
        userID,
        agentInstanceId,
        roomConfig,
      });
    } else {
      // 后续用户：加入已有的 Group Agent 实例
      reqLog(req, 'log', 'group-agent', 'joining existing group agent instance', {
        roomID,
        userID,
        agentInstanceId,
        roomConfig,
      });
      result = await agent.joinGroupAgentInstance(agentInstanceId, userID, rtc);
    }

    return res.json({
      code: 0,
      roomID,
      userID,
      roomConfig,
      agentInstanceId: agentInstanceId || null,
      raw: result,
    });
  } catch (e) {
    reqLog(req, 'error', 'group-agent', 'group agent enter failed', extractError(e));
    return res.status(500).json({ code: 500, msg: 'GroupAgent 接口调用失败' });
  }
});

// ====== ASR 回调示例 ======
// 用于自定义语音识别后的行为：
// - 文本包含“你好”：只写入历史，不触发 LLM 回复
// - 文本包含“请问”：把内容发给 LLM，让 Agent 回复
// - 否则：返回空对象，Agent 不作处理
app.post('/asr-asrresult', async (req, res) => {
  try {
    const data = (req.body && req.body.Data) || {};
    const {AgentInstanceId} = req.body || {};
    const { UserId, MessageId, Text } = data;

    const isAgentMuted = await kvStore.get(getAgentMuteKey(AgentInstanceId))
    if (isAgentMuted === '1') {
      reqLog(req, 'log', 'asr-result', 'ignored ASR result because agent is muted', {
        AgentInstanceId,
        UserId,
        MessageId,
      });
      return res.json({})
    }

    if (!Text) {
      reqLog(req, 'log', 'asr-result', 'ignored empty ASR text', {
        AgentInstanceId,
        UserId,
        MessageId,
      });
      return res.json({});
    }

    reqLog(req, 'log', 'asr-result', 'received ASR text', {
      AgentInstanceId,
      UserId,
      MessageId,
      Text,
    });
    return res.json({
      SendLLM: {
        Text: Text,
      },
    });
  } catch (e) {
    reqLog(req, 'error', 'asr-result', 'failed to process ASR result', extractError(e));
    return res.json({});
  }
});


app.post('/startRecord', async (req, res) => {
  try {
    const { roomID ,isSingle, asrVendor } = req.body || {};
    const agent = ZegoAIAgent.getInstance();
    let roomConfig = await getRoomConfig(roomID);

    if (!roomConfig) {
      roomConfig = normalizeRoomConfig({ isSingle, asrVendor });
      await setRoomConfig(roomID, roomConfig);
    }

    const resp = await agent.describeUserNum(roomID);
    const num = resp.Data.UserCountList[0].UserCount || 0;
    reqLog(req, 'log', 'record', 'evaluating start record request', {
      roomID,
      roomConfig,
      userCount: num,
    });
    //
    if (!roomConfig.isSingle && num === 2){
      reqLog(req, 'log', 'record', 'skipping startRecord for multi interview at two users', {
        roomID,
        roomConfig,
        userCount: num,
      });
      return res.json({
        roomConfig,
      })
    }

    const result = await agent.startRecord(roomID);
    await markRoomUsed(roomID);
    reqLog(req, 'log', 'record', 'record started', {
      roomID,
      roomConfig,
      taskId: result?.Data?.TaskId,
    });
    // const mixedResult = await agent.startMixedRecord(roomID);

    return res.json({
        taskId: result.Data.TaskId,
        roomConfig,
        // mixedTaskId: mixedResult.Data.TaskId,
      ...result
    });
  } catch (e) {
    reqLog(req, 'error', 'record', 'failed to start record', extractError(e));
    return res.json({});
  }
})

app.post('/stopRecord', async (req, res) => {
  try {
    const { taskId, roomId ,agentInstanceId,mixedTaskId} = req.body || {};

    if (!taskId) {
      reqLog(req, 'warn', 'record', 'skip stopRecord because taskId is empty', {
        roomId,
        agentInstanceId,
        mixedTaskId,
      });
      return res.json({});
    }

    const agent = ZegoAIAgent.getInstance();
    const result = await agent.stopRecord(taskId);
    // const mixedResult = await agent.stopRecord(mixedTaskId);

    const resp = await agent.describeUserNum(roomId);
    const num = resp.Data.UserCountList[0].UserCount || 0;
    reqLog(req, 'log', 'record', 'record stopped', {
      roomId,
      taskId,
      agentInstanceId,
      userCount: num,
    });
    // 两个录制+一个人
    if (num === 3){
      reqLog(req, 'log', 'record', 'clearing room cached state and deleting agent instance', {
        roomId,
        agentInstanceId,
      });
      await kvStore.delete(getRoomAgentKey(roomId));
      await kvStore.delete(getRoomConfigKey(roomId));
      await kvStore.delete(getAgentMuteKey(agentInstanceId));

      if (agentInstanceId) {
        await agent.deleteAgentInstance(agentInstanceId);
      }
    }

    return res.json({
      result,
      // mixedResult,
    });
  } catch (e) {
    reqLog(req, 'error', 'record', 'failed to stop record', extractError(e));
    return res.json({});
  }
})

app.post('/recordCallback', async (req, res) => {
  return res.json({});
})

app.post('/commonCallback', async (req, res) => {
  const {Event,RoomId,Data} = req.body || {};
  if (Event === 'AgentInstanceStatus'){
    const targetClient = clients.get(RoomId);
    if (targetClient) {
      targetClient.write(`data: ${JSON.stringify({ type: 'private', msg: Data?.Status })}\n\n`);
      return res.json({ success: true, info: `消息已发给 ${RoomId}` });
    } else {
      reqLog(req, 'warn', 'common-callback', 'missing SSE client for AgentInstanceStatus', { RoomId });
      return res.json({});
    }
  }else if (Event === 'UserSpeakAction'){
    const targetClient = clients.get(RoomId);
    if (targetClient) {
      targetClient.write(`data: ${JSON.stringify({ type: 'private', msg: Data?.Action })}\n\n`);
      return res.json({ success: true, info: `消息已发给 ${RoomId}` });
    } else {
      reqLog(req, 'warn', 'common-callback', 'missing SSE client for UserSpeakAction', { RoomId });
      return res.json({});
    }
  }
  return res.json({});
})

// 使用 Map 存储：key 是 userId, value 是 res 对象
const clients = new Map();

// 1. SSE 连接接口
app.get('/events', (req, res) => {
  const roomId = req.query.roomId; // 从 URL 获取用户 ID，例如 /events?roomId=user123

  if (!roomId) {
    reqLog(req, 'warn', 'sse', 'missing roomId for SSE connection');
    return res.status(400).send('需要 roomId');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 将客户端存入 Map
  clients.set(roomId, res);
  reqLog(req, 'log', 'sse', 'client connected', {
    roomId,
    onlineCount: clients.size,
  });

  // 发送连接成功确认
  res.write(`data: ${JSON.stringify({ type: 'system', msg: `已成功连接，你的 ID 是 ${roomId}` })}\n\n`);

  // 处理断开连接
  req.on('close', () => {
    clients.delete(roomId);
    reqLog(req, 'log', 'sse', 'client disconnected', {
      roomId,
      onlineCount: clients.size,
    });
  });
});

initializeKVStore()
  .then(() => {
    app.listen(port, "0.0.0.0",() => {
      log('log', 'server', 'server started', {
        port,
        kvStoreMode: kvStore.mode,
      });
    });
  })
  .catch((error) => {
    log('error', 'server', 'KV store init failed', extractError(error));
    process.exit(1);
  });
