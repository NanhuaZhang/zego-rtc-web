const {TosClient}  = require('@volcengine/tos-sdk');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ZegoAIAgent } = require('./zegoAIAgent');
const {generateToken04} = require("./token");
const {createClient} = require("redis");

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function randomId(prefix) {
  return prefix + Math.random().toString(36).substring(2, 10);
}

// 从环境变量获取配置
const appID = Number(process.env.NEXT_PUBLIC_ZEGO_APP_ID);
const serverSecret = process.env.ZEGO_SERVER_SECRET;

const redisClient = createClient({
  url: 'redis://localhost:6379'
});
redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect();

const tosClient = new TosClient({
  accessKeyId: process.env.API_ACCESS_KEY,
  accessKeySecret: process.env.API_SECRET_KEY,
  region: process.env.TOS_REGION_ID, // 填写 Bucket 所在地域。以华北2（北京)为例，"Provide your region" 填写为 cn-beijing。
  endpoint: process.env.TOS_ENDPOINT_SINGLE, // 填写域名地址
});

/**
 * 检查 TOS 上的“文件夹”是否存在
 * @param {string} folderPath 文件夹路径，如 "path/to/folder"
 * @returns {Promise<boolean>} true 表示存在，false 表示不存在
 */
async function folderExists(folderPath) {
  // 确保以 "/" 结尾
  if (!folderPath.endsWith('/')) {
    folderPath += '/';
  }

  try {
    const res = await tosClient.listObjectsType2({
      prefix: folderPath,
      maxKeys: 1,  // 只需要检查是否有对象
      bucket: process.env.TOS_BUCKET,
    });

    console.log(res);
    return res.data.Contents.length > 0;
  } catch (err) {
    console.error('检查文件夹出错：', err);
    return false;
  }
}

// ====== token 接口（返回静态 token）======
app.get('/token', (req, res) => {
  try {
    const { userId } = req.query;

    console.log('Request parameters:', {
      url: req.url,
      userId,
    });

    // 验证必要参数
    if (!userId) {
      console.log('Error: userId is missing');
      return res.json(
          {
            code: 400,
            message: 'userId is required'
          },
          { status: 400 }
      );
    }

    if (!appID || !serverSecret) {
      console.log('Error: Server configuration missing:', {
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

    console.log('Generating token with parameters:', {
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

    console.log('Token generated successfully');

    // 返回token
    const response = {
      code: 0,
      message: 'Generate token success',
      token,
      user_id: userId,
      expire_time: Date.now() + effectiveTimeInSeconds * 1000
    };

    console.log('Sending response:', {
      hasToken: !!token,
      userId,
      expireTime: response.expire_time,
    });

    return res.json(response);
  } catch (e) {
    console.error('[zego-token-server] 返回 token 失败：', e);
    return res.status(500).json({ code: 500, msg: '返回 token 失败' });
  }
});

// ====== Group Agent 接口（Create / Join）======
const agentName = '李浩然';

app.post('/check', async (req, res) => {
  try {
    const {roomID} = req.body || {};
    const existRoom = await folderExists(roomID);
    return res.json({
      code: 0,
      existRoom
    })
  }catch(e) {
    console.error('[check] 处理失败：', e?.response?.data || e);
    return res.status(500).json({ code: 500, msg: 'check 接口调用失败' });
  }
})

app.post('/interrupt', async (req, res) => {
  try {
    const {agentInstanceId} = req.body || {};
    const agent = ZegoAIAgent.getInstance();
    const result = await agent.interruptAgentInstance(agentInstanceId);
    return res.json({
      code: 0,
      result
    })
  }catch(e) {
    console.error('[interrupt] 处理失败：', e?.response?.data || e);
    return res.status(500).json({ code: 500, msg: 'interrupt 接口调用失败' });
  }
})

app.post('/mute', async (req, res) => {
  try {
    const {isAgentMuted,agentInstanceId} = req.body || {};
    await redisClient.set(agentInstanceId+'_mute',isAgentMuted ? 1:0);
    return res.json({
      code: 0,
    })
  }catch(e) {
    console.error('[interrupt] 处理失败：', e?.response?.data || e);
    return res.status(500).json({ code: 500, msg: 'interrupt 接口调用失败' });
  }
})

// 前端只需要调用这个接口：服务器内部根据是否已经有实例自动选择 Create 或 Join
app.post('/group-agent/enter', async (req, res) => {
  try {
    const { roomID, userID, rtcInfo } = req.body || {};
    if (!roomID || !userID) {
      return res.status(400).json({ code: 400, msg: '缺少 roomID 或 userID' });
    }

    const agent = ZegoAIAgent.getInstance();
    let agentInstanceId = await redisClient.get(roomID);
    let result;

    // 如果前端没有传 RTC 信息，这里根据房间做一个最简单的占位结构
    const rtc = {
      RoomId: roomID,
      AgentStreamId: rtcInfo.AgentStreamId || randomId('stream_agent_'),
      AgentUserId: randomId('ai_agent_'),
      UserStreamId: rtcInfo.UserStreamId,
    };

    await agent.ensureAgentRegistered(rtc.AgentUserId, agentName);

    if (!agentInstanceId) {
      // 第一个用户：创建 Group Agent 实例
      result = await agent.createGroupAgentInstance(rtc.AgentUserId, userID, rtc);
      // 从返回中推断 AgentInstanceId（字段名可按文档调整）
      agentInstanceId =
        (result && result.Data && (result.Data.AgentInstanceId || result.Data.AgentInstanceID)) ||
        result.AgentInstanceId ||
        null;
      if (agentInstanceId) {
        await redisClient.set(roomID, agentInstanceId);
      }
    } else {
      // 后续用户：加入已有的 Group Agent 实例
      result = await agent.joinGroupAgentInstance(agentInstanceId, userID, rtc);
    }

    return res.json({
      code: 0,
      roomID,
      userID,
      agentInstanceId: agentInstanceId || null,
      raw: result,
    });
  } catch (e) {
    console.error('[zego-group-agent] 处理失败：', e?.response?.data || e);
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

    const isAgentMuted = await redisClient.get(AgentInstanceId+'_mute',)
    if (isAgentMuted === '1') {
      return res.json({})
    }

    if (!Text) {
      return res.json({});
    }

    console.log('[asrresult] 收到识别结果：', { UserId, MessageId, Text });
    return res.json({
      SendLLM: {
        Text: Text,
      },
    });
  } catch (e) {
    console.error('[asrresult] 处理失败：', e);
    return res.json({});
  }
});


app.post('/startRecord', async (req, res) => {
  try {
    const { roomID ,isSingle} = req.body || {};
    const agent = ZegoAIAgent.getInstance();

    const resp = await agent.describeUserNum(roomID);
    const num = resp.Data.UserCountList[0].UserCount || 0;
    //
    if (!isSingle && num === 2){
      console.log('startRecord when 2 people in room')
      return res.json({})
    }

    const result = await agent.startRecord(roomID);
    const mixedResult = await agent.startMixedRecord(roomID);

    return res.json({
        taskId: result.Data.TaskId,
        mixedTaskId: mixedResult.Data.TaskId,
      ...result
    });
  } catch (e) {
    console.error('[startRecord] 处理失败：', e);
    return res.json({});
  }
})

app.post('/stopRecord', async (req, res) => {
  try {
    const { taskId, roomId ,agentInstanceId,mixedTaskId} = req.body || {};

    if (!taskId) {
      console.log(taskId, 'is null');
      return res.json({});
    }

    const agent = ZegoAIAgent.getInstance();
    const result = await agent.stopRecord(taskId);
    const mixedResult = await agent.stopRecord(mixedTaskId);

    const resp = await agent.describeUserNum(roomId);
    const num = resp.Data.UserCountList[0].UserCount || 0;
    // 两个录制+一个人
    if (num === 3){
      console.log('clear roomGroupAgentMap');
      await redisClient.delete(roomId);
      await redisClient.delete(agentInstanceId+'_mute');

      if (agentInstanceId) {
        await agent.deleteAgentInstance(agentInstanceId);
      }
    }

    return res.json({
      result,
      mixedResult,
    });
  } catch (e) {
    console.error('[startRecord] 处理失败：', e);
    return res.json({});
  }
})

app.post('/recordCallback', async (req, res) => {
  console.log('record callback',JSON.stringify(req.body));

  return res.json({});
})

app.post('/commonCallback', async (req, res) => {
  console.log('common callback',JSON.stringify(req.body));
  const {Event,RoomId,Data} = req.body || {};
  if (Event === 'AgentInstanceStatus'){
    const targetClient = clients.get(RoomId);
    if (targetClient) {
      targetClient.write(`data: ${JSON.stringify({ type: 'private', msg: Data?.Status })}\n\n`);
      console.log(`消息已发给 ${RoomId}`);
      return res.json({ success: true, info: `消息已发给 ${RoomId}` });
    } else {
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
    return res.status(400).send('需要 roomId');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 将客户端存入 Map
  clients.set(roomId, res);
  console.log(`用户 ${roomId} 已连接。当前在线: ${clients.size}`);

  // 发送连接成功确认
  res.write(`data: ${JSON.stringify({ type: 'system', msg: `已成功连接，你的 ID 是 ${roomId}` })}\n\n`);

  // 处理断开连接
  req.on('close', () => {
    clients.delete(roomId);
    console.log(`用户 ${roomId} 断开连接。剩余在线: ${clients.size}`);
  });
});

app.listen(port, "0.0.0.0",() => {
  console.log(`[zego-token-server] 启动成功，端口: ${port}`);
});

