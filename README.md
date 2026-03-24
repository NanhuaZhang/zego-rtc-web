# Zego Express Web

## Local Dev

Frontend:

```bash
npm start
```

Backend with real Redis:

```bash
npm run server
```

Backend with in-memory Redis mock:

```bash
npm run server:mock
```

If you prefer running inside the `server` directory:

```bash
cd server
npm run server:mock
```

## Notes

- `server:mock` uses `REDIS_MODE=memory`, so you do not need to start a local Redis instance.
- The server now also falls back to the in-memory store automatically when Redis is unavailable and `REDIS_MODE` is not forced to `redis`.
- Backend logs support `LOG_LEVEL=debug|log|warn|error`. Default is `log`.
- Every backend request now carries an `x-request-id`, and downstream ZEGO API logs reuse the same request trace id.
- Same `roomID` is treated as one interview session. The first entrant locks the room config, including `single/multi` mode and `asrVendor`.
- Supported special ASR route parameter is `AliyunParaformer`.

Examples:

```text
/single
/single/AliyunParaformer
/single?asr=AliyunParaformer
```
