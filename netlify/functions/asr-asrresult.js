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

    if (Text.includes('你好')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          AddHistory: {
            Text: '小红说:' + Text,
          },
        }),
      };
    }

    if (Text.includes('请问')) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          SendLLM: {
            Text: '小红说:' + Text,
          },
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({}),
    };
  } catch (e) {
    console.error('[netlify asrresult] 处理失败：', e);
    return {
      statusCode: 200,
      body: JSON.stringify({}),
    };
  }
};

