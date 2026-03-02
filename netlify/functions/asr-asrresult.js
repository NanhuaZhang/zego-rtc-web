exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: 'Method Not Allowed',
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const data = body.Data || {};
    const { UserId, MessageId, Text } = data;

    if (!Text) {
      return {
        statusCode: 200,
        body: JSON.stringify({}),
      };
    }

    console.log('[netlify asrresult] 收到识别结果：', { UserId, MessageId, Text });

    return {
      SendLLM: {
        Text:  Text,
      },
    }
  } catch (e) {
    console.error('[netlify asrresult] 处理失败：', e);
    return {
      statusCode: 200,
      body: JSON.stringify({}),
    };
  }
};

