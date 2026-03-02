const { createHash } = require('crypto');
const axios = require('axios');

const CONSTANTS = {
  AGENT_ID: 'ai_agent_example_1',
  AGENT_NAME: '李浩然',
};

class ZegoAIAgent {
  static instance;

  constructor(config) {
    this.appId = config.appId;
    this.serverSecret = config.serverSecret;
    this.baseUrl = 'https://aigc-aiagent-api.zegotech.cn';
  }

  static getInstance() {
    if (!ZegoAIAgent.instance) {
      const appId = Number(process.env.ZEGO_APP_ID || process.env.NEXT_PUBLIC_ZEGO_APP_ID);
      const serverSecret = process.env.ZEGO_SERVER_SECRET || '';

      if (!appId || !serverSecret) {
        throw new Error('ZEGO_APP_ID/NEXT_PUBLIC_ZEGO_APP_ID 和 ZEGO_SERVER_SECRET 必须在环境变量中配置');
      }

      ZegoAIAgent.instance = new ZegoAIAgent({ appId, serverSecret });
    }
    return ZegoAIAgent.instance;
  }

  generateSignature({ appId, signatureNonce, serverSecret, timestamp }) {
    const str = `${appId}${signatureNonce}${serverSecret}${timestamp}`;
    const hash = createHash('md5');
    hash.update(str);
    return hash.digest('hex');
  }

  generateCommonParams(action) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signatureNonce = Math.random().toString(36).substring(2);
    const signature = this.generateSignature({
      appId: this.appId,
      signatureNonce,
      serverSecret: this.serverSecret,
      timestamp,
      action,
    });

    return {
      AppId: this.appId,
      SignatureNonce: signatureNonce,
      Timestamp: timestamp,
      SignatureVersion: '2.0',
      Signature: signature,
    };
  }

  buildUrl(action, commonParams, baseUrl) {
    const params = new URLSearchParams({
      Action: action,
      AppId: commonParams.AppId.toString(),
      SignatureNonce: commonParams.SignatureNonce,
      Timestamp: commonParams.Timestamp.toString(),
      SignatureVersion: commonParams.SignatureVersion,
      Signature: commonParams.Signature,
    });
    const root = baseUrl || this.baseUrl;
    return `${root}/?${params.toString()}`;
  }

  async sendRequest(action, body, baseURL, method = 'POST') {
    const commonParams = this.generateCommonParams(action);
    const url = this.buildUrl(action, commonParams, baseURL);

    const resp = await axios({
      method,
      url,
      headers: { 'Content-Type': 'application/json' },
      data: body || undefined,
      timeout: 20000,
    });

    return resp.data;
  }

  async createGroupAgentInstance(agentId, userId, rtcInfo) {
    const action = 'CreateGroupAgentInstance';
    const body = {
      AgentId: agentId,
      UserId: userId,
      RTC: rtcInfo,
      MessageHistory: {
        SyncMode: 1,
        Messages: [],
        WindowSize: 10,
      },
    };
    return this.sendRequest(action, body);
  }

  async joinGroupAgentInstance(agentInstanceId, userId, rtcInfo) {
    const action = 'JoinGroupAgentInstance';
    const body = {
      AgentInstanceId: agentInstanceId,
      UserId: userId,
      RTC: rtcInfo,
    };
    return this.sendRequest(action, body);
  }
}

module.exports = {
  ZegoAIAgent,
  CONSTANTS,
};

