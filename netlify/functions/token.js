exports.handler = async (event) => {
  try {
    const userID = event.queryStringParameters && event.queryStringParameters.userID;

    if (!userID) {
      return {
        statusCode: 400,
        body: JSON.stringify({ code: 400, msg: '缺少 userID 参数' }),
      };
    }

    const staticToken = process.env.ZEGO_STATIC_TOKEN || '';
    if (!staticToken) {
      return {
        statusCode: 500,
        body: JSON.stringify({ code: 500, msg: '服务器未配置 ZEGO_STATIC_TOKEN' }),
      };
    }

    const effectiveTimeInSeconds = 3600;

    return {
      statusCode: 200,
      body: JSON.stringify({
        code: 0,
        token: staticToken,
        expireAt: Math.floor(Date.now() / 1000) + effectiveTimeInSeconds,
      }),
    };
  } catch (e) {
    console.error('[token-fn] 返回 token 失败：', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ code: 500, msg: '返回 token 失败' }),
    };
  }
};

