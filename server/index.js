const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { ZegoAIAgent, CONSTANTS } = require('./zegoAIAgent');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function randomId(prefix) {
  return prefix + Math.random().toString(36).substring(2, 10);
}

// 这里改为从环境变量读取一个“静态 token”，避免依赖不存在的 SDK。
// 你可以把从 Zego 控制台/你自己的后端生成的 token 配在 .env 里：
// ZEGO_STATIC_TOKEN=xxxx
const staticToken = process.env.ZEGO_STATIC_TOKEN || '';

// ====== token 接口（返回静态 token）======
app.get('/token', (req, res) => {
  try {
    const { userID } = req.query;

    if (!userID) {
      return res.status(400).json({ code: 400, msg: '缺少 userID 参数' });
    }
    if (!staticToken) {
      return res
        .status(500)
        .json({ code: 500, msg: '服务器未配置 ZEGO_STATIC_TOKEN' });
    }

    // 这里不真正计算过期时间，仅简单返回一个未来时间戳，前端目前也没有用到它
    const effectiveTimeInSeconds = 3600;

    return res.json({
      code: 0,
      token: staticToken,
      expireAt: Math.floor(Date.now() / 1000) + effectiveTimeInSeconds,
    });
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

app.listen(port, () => {
  console.log(`[zego-token-server] 启动成功，端口: ${port}`);
});

