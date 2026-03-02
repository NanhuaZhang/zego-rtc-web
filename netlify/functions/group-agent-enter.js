const { ZegoAIAgent, CONSTANTS } = require('./lib/zegoAIAgent');

// 注意：Netlify Functions 是无状态的；此内存 Map 仅对“同一热实例”有效。
// 如果你需要严格保证“首个用户 Create，后续 Join”，建议接入持久化存储（Redis/DB）保存 room -> agentInstanceId。
const roomAgentInstanceMap = new Map();

function randomId(prefix) {
  return prefix + Math.random().toString(36).substring(2, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { roomID, userID, rtcInfo } = body || {};

    if (!roomID || !userID) {
      return {
        statusCode: 400,
        body: JSON.stringify({ code: 400, msg: '缺少 roomID 或 userID' }),
      };
    }

    const agent = ZegoAIAgent.getInstance();
    let agentInstanceId = roomAgentInstanceMap.get(roomID);

    const rtc = rtcInfo || {
      RoomId: roomID,
      AgentStreamId: randomId('stream_agent_'),
      AgentUserId: CONSTANTS.AGENT_ID,
      UserStreamId: '',
    };

    let result;
    if (!agentInstanceId) {
      result = await agent.createGroupAgentInstance(CONSTANTS.AGENT_ID, userID, rtc);
      agentInstanceId =
        (result &&
          result.Data &&
          (result.Data.AgentInstanceId || result.Data.AgentInstanceID)) ||
        result.AgentInstanceId ||
        null;

      if (agentInstanceId) {
        roomAgentInstanceMap.set(roomID, agentInstanceId);
      }
    } else {
      result = await agent.joinGroupAgentInstance(agentInstanceId, userID, rtc);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        code: 0,
        roomID,
        userID,
        agentInstanceId: agentInstanceId || null,
        raw: result,
      }),
    };
  } catch (e) {
    console.error('[group-agent-enter-fn] 处理失败：', e?.response?.data || e);
    return {
      statusCode: 500,
      body: JSON.stringify({ code: 500, msg: 'GroupAgent 接口调用失败' }),
    };
  }
};

