const { createHash } = require('crypto');
const axios = require('axios');
const { extractError, log } = require('./logger');

/**
 * 判断两个对象是否相等
 * @param obj1
 * @param obj2
 * @returns
 */
function isEqual(obj1, obj2) {
  // 检查是否为同一引用
  if (obj1 === obj2) {
    return true;
  }

  // 检查是否为 null 或非对象类型
  if (obj1 === null || obj2 === null || typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;

  // 检查数组情况
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) return false;
    for (let i = 0; i < obj1.length; i++) {
      if (!isEqual(obj1[i], obj2[i])) return false;
    }
    return true;
  }

  // 检查对象情况
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!keys2.includes(key) || !isEqual(obj1[key], obj2[key])) return false;
  }

  return true;
}

const SYSTEM_PROMPT = `
一、基础人设
名称：豆包
性别：女
年龄：27 岁
身份：专业对话主持人、倾听引导者
二、性格特点
温和耐心、专注倾听、共情力强、节奏稳定，绝不主动打断用户发言，始终等用户完整表达后再进行回应，不抢话、不插话、不强行输出观点。
三、语言风格
极度精炼，单轮回答不超过 50 个字，最多不超过 3 句话；
无多余废话、无客套铺垫、无冗长解释；
语气自然亲切，适配语音通话场景，清晰易懂。
四、核心任务
对用户的发言做出自然、简短的正向回应；
依据用户当前话题，用轻量提问逐步引导用户多说细节、多表达；
平稳承接话题，保证对话流畅延续，顺利完成 10 轮及以上有效对话；
全程以用户表达为主，只做倾听、轻反馈、轻引导。
`;

class ZegoAIAgent {
  static instance;

  constructor(config) {
    this.appId = config.appId;
    this.serverSecret = config.serverSecret;
    this.baseUrl = 'https://aigc-aiagent-api.zegotech.cn';
    this.cloudUrl = 'https://cloudrecord-api.zego.im';
    this.rtcUrl = 'https://rtc-api.zego.im';
  }

  static getInstance() {
    if (!ZegoAIAgent.instance) {
      const appId = Number(process.env.ZEGO_APP_ID || process.env.NEXT_PUBLIC_ZEGO_APP_ID);
      const serverSecret = process.env.ZEGO_SERVER_SECRET || '';

      if (!appId || !serverSecret) {
        throw new Error('ZEGO_APP_ID/NEXT_PUBLIC_ZEGO_APP_ID 和 ZEGO_SERVER_SECRET 必须在环境变量中配置');
      }

      ZegoAIAgent.instance = new ZegoAIAgent({
        appId,
        serverSecret,
      });
    }
    return ZegoAIAgent.instance;
  }

  generateSignature(params) {
    const { appId, signatureNonce, serverSecret, timestamp } = params;
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
      ...commonParams,
      Action: action,
      AppId: commonParams.AppId.toString(),
      SignatureNonce: commonParams.SignatureNonce,
      Timestamp: commonParams.Timestamp.toString(),
      SignatureVersion: commonParams.SignatureVersion,
      Signature: commonParams.Signature,
    });

    if (baseUrl) {
      return `${baseUrl}/?${params.toString()}`;
    } else {
      return `${this.baseUrl}/?${params.toString()}`;
    }
  }

  async sendRequest(action, body, baseURL, method = 'POST') {
    const commonParams = this.generateCommonParams(action);
    const url = this.buildUrl(action, commonParams, baseURL);
    const startedAt = Date.now();

    const config = {
      method,
      url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: body || undefined,
    };

    log('log', 'zego-ai-agent', 'sending request', {
      action,
      method,
      url,
      body,
    });
    try {
      const response = await axios(config);
      log('log', 'zego-ai-agent', 'request completed', {
        action,
        durationMs: Date.now() - startedAt,
        response: response.data,
      });
      return response.data;
    } catch (error) {
      log('error', 'zego-ai-agent', 'request failed', {
        action,
        durationMs: Date.now() - startedAt,
        error: extractError(error),
      });
      throw error;
    }
  }

  getDefaultAgentConfig() {
    return {
      LLM: {
        Url: process.env.LLM_BASE_URL || '',
        ApiKey: process.env.LLM_API_KEY || '',
        Model: process.env.LLM_MODEL || '',
        SystemPrompt: process.env.LLM_SYSTEM_PROMPT || SYSTEM_PROMPT,
      },
      TTS: {
        Vendor: 'ByteDance',
        Params: {
          app: {
            appid: process.env.TTS_BYTEDANCE_APP_ID || '',
            token: process.env.TTS_BYTEDANCE_TOKEN || '',
            cluster: process.env.TTS_BYTEDANCE_CLUSTER || '',
          },
          speed_ratio: 1,
          volume_ratio: 1,
          pitch_ratio: 1,
          emotion: 'happy',
          audio: {
            rate: 24000,
            voice_type: process.env.TTS_BYTEDANCE_VOICE_TYPE || '',
          },
        },
        FilterText: [
          { BeginCharacters: '(', EndCharacters: ')' },
          { BeginCharacters: '（', EndCharacters: '）' },
          { BeginCharacters: '{', EndCharacters: '}' },
        ],
      },
      ASR: {
        VADSilenceSegmentation: 1000,
        PauseInterval: 1000
      },
    };
  }

  getAliyunParaformerAsrConfig() {
    return {
      Vendor: 'AliyunParaformer',
      Params: {},
      VADSilenceSegmentation: 1000,
      PauseInterval: 1000
    };
  }

  getDesiredAgentConfig(llmConfig = null, ttsConfig = null, asrConfig = null) {
    const { LLM, TTS, ASR } = this.getDefaultAgentConfig();
    return {
      LLM: llmConfig || LLM,
      TTS: ttsConfig || TTS,
      ASR: asrConfig || ASR,
    };
  }

  async registerAgent(agentId, agentName, llmConfig = null, ttsConfig = null, asrConfig = null) {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('LLM_BASE_URL、LLM_API_KEY 和 LLM_MODEL 必须在环境变量中配置');
    }
    const { LLM, TTS, ASR } = this.getDesiredAgentConfig(llmConfig, ttsConfig, asrConfig);
    const action = 'RegisterAgent';
    const body = {
      AgentId: agentId,
      Name: agentName,
      LLM,
      TTS,
      ASR,
    };
    return this.sendRequest(action, body);
  }

  async interruptAgentInstance(agentInstanceId) {
    const action = 'InterruptAgentInstance';
    const body = {
      AgentInstanceId: agentInstanceId
    };
    return this.sendRequest(action, body);
  }

  async deleteAgentInstance(agentInstanceId) {
    // https://aigc-aiagent-api.zegotech.cn?Action=DeleteAgentInstance
    const action = 'DeleteAgentInstance';
    const body = {
      AgentInstanceId: agentInstanceId
    };
    const result = await this.sendRequest(action, body);
    log('log', 'zego-ai-agent', 'agent instance deleted', {
      agentInstanceId,
      result,
    });
    return result;
  }

  async listAgents(limit, cursor) {
    // https://aigc-aiagent-api.zegotech.cn?Action=ListAgents
    const action = 'ListAgents';
    const body = {};

    if (limit !== undefined) body.Limit = limit;
    if (cursor) body.Cursor = cursor;

    const result = await this.sendRequest(action, body);
    log('log', 'zego-ai-agent', 'listed agents', {
      limit,
      cursor,
      result,
    });
    return result;
  }

  async createGroupAgentInstance(
    agentId,
    userId,
    rtcInfo,
    llmConfig = null,
    ttsConfig = null,
    asrConfig = null,
    messageHistory = null,
    callbackConfig = { AgentInstanceStatus:1 ,UserSpeakAction:1},
    advancedConfig = null
  ) {
    const action = 'CreateGroupAgentInstance';
    const body = {
      AgentId: agentId,
      UserId: userId,
      RTC: rtcInfo,
      MessageHistory:
        messageHistory || {
          SyncMode: 1,
          Messages: [],
          WindowSize: 10,
        },
      LLM: llmConfig,
      TTS: ttsConfig,
      ASR: asrConfig,
      CallbackConfig: callbackConfig,
      AdvancedConfig: advancedConfig,
      CustomNodes: [
        {
          Type: 'HTTP',
          Position: 'ASR_POST',
          Url: 'https://ots-ai-review.appendata.com:8082/asr-asrresult',
        },
      ],
    };
    const result = await this.sendRequest(action, body);
    return result;
  }

  buildAsrConfig(asrVendor) {
    if (!asrVendor) {
      return null;
    }

    if (String(asrVendor).trim().toLowerCase() === 'aliyunparaformer') {
      return this.getAliyunParaformerAsrConfig();
    }

    return null;
  }

  async joinGroupAgentInstance(agentInstanceId, userId, rtcInfo) {
    const action = 'JoinGroupAgentInstance';
    const body = {
      AgentInstanceId: agentInstanceId,
      UserId: userId,
      UserStreamId: rtcInfo.UserStreamId,
    };
    const result = await this.sendRequest(action, body);
    return result;
  }

  // 智能体注册逻辑
  async ensureAgentRegistered(agentId, agentName, asrConfig = null){
    try {
      const agents = await this.queryAgents([agentId]);
      const agentExists = agents?.length > 0 &&
          agents.find((agent) => agent.AgentId === agentId);

      if (!agentExists) {
        await this.registerAgent(agentId, agentName, null, null, asrConfig);
        log('log', 'zego-ai-agent', 'agent registered', {
          agentId,
          agentName,
          asrConfig,
        });
      } else {
        log('log', 'zego-ai-agent', 'agent already exists', {
          agentId,
          agentName,
        });
        const isConfigEqual = this.compareAgentConfig(agentExists, null, null, asrConfig)
        log('log', 'zego-ai-agent', 'agent config compared', {
          agentId,
          isConfigEqual,
          asrConfig,
        });
        if (!isConfigEqual) {
          await this.updateAgent(agentId, agentName, null, null, asrConfig);
        }
      }
    } catch (error) {
      log('error', 'zego-ai-agent', 'failed to ensure agent registration', {
        agentId,
        agentName,
        asrConfig,
        error: extractError(error),
      });
      throw new Error(`智能体注册失败: ${error.message}`);
    }
  }

  async updateAgent(agentId, agentName, llmConfig = null, ttsConfig = null, asrConfig = null) {
    if (!process.env.LLM_BASE_URL || !process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('LLM_BASE_URL, LLM_API_KEY and LLM_MODEL environment variables must be set');
    }
    const { LLM, TTS, ASR } = this.getDesiredAgentConfig(llmConfig, ttsConfig, asrConfig);
    // https://aigc-aiagent-api.zegotech.cn?Action=UpdateAgent
    const action = 'UpdateAgent';
    const body = {
      AgentId: agentId,
      Name: agentName,
      LLM,
      TTS,
      ASR
    };
    log('log', 'zego-ai-agent', 'updating agent', {
      agentId,
      agentName,
      body,
    });
    return this.sendRequest(action, body);
  }

  compareAgentConfig(config, llmConfig = null, ttsConfig = null, asrConfig = null) {
    const desiredConfig = this.getDesiredAgentConfig(llmConfig, ttsConfig, asrConfig);
    const {
      LLM,
      TTS,
      ASR,
    } = desiredConfig;

    return isEqual(
      {
        LLM: config.LLM,
        TTS: config.TTS,
        ASR: config.ASR
      },
      {
        LLM,
        TTS,
        ASR
      }
    );
  }

  async queryAgents(agentIds) {
    // https://aigc-aiagent-api.zegotech.cn?Action=QueryAgents
    const action = 'QueryAgents';
    const body = {
      AgentIds: agentIds
    };
    const result = await this.sendRequest(action, body);
    log('log', 'zego-ai-agent', 'queried agents', {
      agentIds,
      result,
    });
    return result.Data.Agents;
  }

  async startRecord(roomId) {
    const action = 'StartRecord';
    const body = {
      RoomId: roomId,
      "RecordInputParams": {
        "RecordMode": 1,
        "StreamType": 1,
        "MaxIdleTime": 60
      },
      "RecordOutputParams": {
        "OutputFileFormat": "mp3",
        "OutputFolder": roomId + "/",
      },
      StorageParams: {
        "Vendor": 10,
        "Region": process.env.TOS_REGION_ID,
        "Bucket": process.env.TOS_BUCKET,
        "AccessKeyId": process.env.API_ACCESS_KEY,
        "AccessKeySecret": process.env.API_SECRET_KEY,
        "EndPoint": process.env.TOS_ENDPOINT
      }
    };
    return this.sendRequest(action, body, this.cloudUrl);
  }

  async startMixedRecord(roomId) {
    const action = 'StartRecord';
    const body = {
      RoomId: roomId,
      "RecordInputParams": {
        "RecordMode": 2,
        "StreamType": 1,
        "MaxIdleTime": 60,
        MixConfig:{
          MixOutputStreamId: 'MixOutputStreamId',
        }
      },
      "RecordOutputParams": {
        "OutputFileFormat": "mp3",
        "OutputFolder": roomId + "/",
      },
      StorageParams: {
        "Vendor": 10,
        "Region": process.env.TOS_REGION_ID,
        "Bucket": process.env.TOS_BUCKET,
        "AccessKeyId": process.env.API_ACCESS_KEY,
        "AccessKeySecret": process.env.API_SECRET_KEY,
        "EndPoint": process.env.TOS_ENDPOINT
      }
    };
    return this.sendRequest(action, body, this.cloudUrl);
  }

  async stopRecord(taskId) {
    const action = 'StopRecord';
    const body = {
      TaskId: taskId
    };
    return this.sendRequest(action, body, this.cloudUrl);
  }

  async describeUserNum(roomId) {
    const action = 'DescribeUserNum';
    const body = {
    };

    const commonParams = this.generateCommonParams(action);
    const url = this.buildUrl(action, {...commonParams,'RoomId[]':roomId}, this.rtcUrl);
    const startedAt = Date.now();

    const config = {
      method: "Get",
      url,
      headers: {
        'Content-Type': 'application/json',
      },
      data: body || undefined,
    };
    log('log', 'zego-ai-agent', 'sending request', {
      action,
      method: 'GET',
      url,
      roomId,
    });
    try {
      const response = await axios(config);
      log('log', 'zego-ai-agent', 'request completed', {
        action,
        roomId,
        durationMs: Date.now() - startedAt,
        response: response.data,
      });
      return response.data;
    } catch (error) {
      log('error', 'zego-ai-agent', 'request failed', {
        action,
        roomId,
        durationMs: Date.now() - startedAt,
        error: extractError(error),
      });
      throw error;
    }
  }
}

module.exports = {
  ZegoAIAgent,
  SYSTEM_PROMPT,
};
