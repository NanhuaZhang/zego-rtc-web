const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ZegoAIAgent, CONSTANTS } = require('./zegoAIAgent');
const {generateToken04} = require("./token");

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

// 简单的内存缓存：roomID -> agentInstanceId
const roomGroupAgentMap = new Map();

// 前端只需要调用这个接口：服务器内部根据是否已经有实例自动选择 Create 或 Join
app.post('/group-agent/enter', async (req, res) => {
  try {
    const { roomID, userID, rtcInfo } = req.body || {};
    if (!roomID || !userID) {
      return res.status(400).json({ code: 400, msg: '缺少 roomID 或 userID' });
    }

    const agent = ZegoAIAgent.getInstance();

    let agentInstanceId = roomGroupAgentMap.get(roomID);
    let result;

    // 如果前端没有传 RTC 信息，这里根据房间做一个最简单的占位结构
    const rtc = {
      RoomId: roomID,
      AgentStreamId: rtcInfo.AgentStreamId || randomId('stream_agent_'),
      AgentUserId: CONSTANTS.AGENT_ID,
      UserStreamId: rtcInfo.UserStreamId,
    };

    console.log(rtc);
    if (!agentInstanceId) {
      // 第一个用户：创建 Group Agent 实例
      result = await agent.createGroupAgentInstance(CONSTANTS.AGENT_ID, userID, rtc);
      // 从返回中推断 AgentInstanceId（字段名可按文档调整）
      agentInstanceId =
        (result && result.Data && (result.Data.AgentInstanceId || result.Data.AgentInstanceID)) ||
        result.AgentInstanceId ||
        null;
      if (agentInstanceId) {
        roomGroupAgentMap.set(roomID, agentInstanceId);
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
app.post('/asr-asrresult', (req, res) => {
  try {
    const data = (req.body && req.body.Data) || {};
    const { UserId, MessageId, Text } = data;

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
    if (!isSingle && num === 2){
      console.log('startRecord when 2 people in room')
      return res.json({})
    }

    const result = await agent.startRecord(roomID);

    return res.json({
        taskId: result.Data.TaskId,
      ...result
    });
  } catch (e) {
    console.error('[startRecord] 处理失败：', e);
    return res.json({});
  }
})

app.post('/stopRecord', async (req, res) => {
  try {
    const { taskId,roomId } = req.body || {};

    if (!taskId) {
      console.log(taskId, 'is null');
      return res.json({});
    }

    const agent = ZegoAIAgent.getInstance();
    const result = await agent.stopRecord(taskId);

    const resp = await agent.describeUserNum(roomId);
    const num = resp.Data.UserCountList[0].UserCount || 0;
    if (num === 2){
      console.log('clear roomGroupAgentMap');
      roomGroupAgentMap.delete(roomId);
    }

    return res.json({
      ...result
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

app.listen(port, "0.0.0.0",() => {
  console.log(`[zego-token-server] 启动成功，端口: ${port}`);
});

