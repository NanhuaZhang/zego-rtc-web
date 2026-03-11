import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { ZegoExpressEngine } from 'zego-express-engine-webrtc';
import {useLocation} from "react-router-dom";
import {message} from "antd";

type ZegoRemoteStream = {
  streamID: string;
  mediaStream: MediaStream;
  userID?: string;
  userName?: string;
};

const IS_DEV = process.env.NODE_ENV === 'development';

const APP_ID_PLACEHOLDER = Number(process.env.REACT_APP_ZEGO_APP_ID || 1814816985); // 在 .env 里配置 REACT_APP_ZEGO_APP_ID
const SERVER_PLACEHOLDER = process.env.REACT_APP_ZEGO_SERVER || 'wss://accesshub-wss.zego.im/accesshub'; // 在 .env 里配置 REACT_APP_ZEGO_SERVER
const TOKEN_PLACEHOLDER = process.env.REACT_APP_ZEGO_TOKEN || ''; // demo：可在 .env 里配置一个固定 token，正式建议从服务端获取

function App() {
  const [appID, setAppID] = useState<number>(APP_ID_PLACEHOLDER);
  const [server, setServer] = useState<string>(SERVER_PLACEHOLDER);
  const [roomID, setRoomID] = useState<string>('demo-room');
  const [userID, setUserID] = useState<string>(() => `user_${Math.floor(Math.random() * 10000)}`);
  const [userName, setUserName] = useState<string>('Demo User');
  const [taskId, setTaskId] = useState<string | undefined>(undefined);
  const [mixedTaskId, setMixedTaskId] = useState<string | undefined>(undefined);
  const [token, setToken] = useState<string>(TOKEN_PLACEHOLDER); // 正式环境请从你的业务服务器获取 token
  const [agentId, setAgentId] = useState<string | undefined>(undefined); // 正式环境请从你的业务服务器获取 token

  const [isInitializing, setIsInitializing] = useState<boolean>(false);
  const [isInRoom, setIsInRoom] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [isMuted, setIsMuted] = useState<boolean>(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<ZegoRemoteStream[]>([]);

  const engineRef = useRef<ZegoExpressEngine | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  const location = useLocation()
  const isSingle = location.pathname.includes("single")

  const ensureEngine = useCallback(() => {
    if (engineRef.current) return engineRef.current;
    if (!appID || !server) {
      throw new Error('请先填写正确的 appID 和 server 地址（在 Zego 控制台获取）');
    }

    const engine = new ZegoExpressEngine(appID, server);
    engineRef.current = engine;

    // 监听远端流更新事件，实现多人通话
    engine.on(
      'roomStreamUpdate' as any,
      async (
        _roomID: string,
        updateType: 'ADD' | 'DELETE',
        streamList: any[],
        _extendedData: string
      ) => {
        if (updateType === 'ADD') {
          const playResults = await Promise.all(
            streamList.map(async streamInfo => {
              const streamID = streamInfo.streamID as string;
              try {
                const mediaStream = (await engine.startPlayingStream(streamID)) as MediaStream;
                // // 创建媒体流播放组件对象，用于播放远端媒体流 。
                // const remoteView = engine.createRemoteStreamView(mediaStream);
                // const divs = document.getElementsByClassName('zego-remote-grid');
                // const newStream = document.createElement("div");
                // newStream.id = streamID;
                // divs[0].appendChild(newStream);
                //
                // // 将播放组件挂载到页面，"remote-video" 为组件容器 <div> 元素的 id 。
                // remoteView.play(streamID);

                return {
                  ok: true,
                  stream: {
                    streamID,
                    mediaStream,
                    userID: streamInfo.user?.userID,
                    userName: streamInfo.user?.userName,
                  } as ZegoRemoteStream,
                } as const;
              } catch (e) {
                console.error('startPlayingStream 失败', streamID, e);
                return { ok: false, streamID } as const;
              }
            })
          );

          setRemoteStreams(prev => {
            const map = new Map(prev.map(s => [s.streamID, s]));
            playResults.forEach(r => {
              if (r.ok && !map.has(r.stream.streamID)) {
                map.set(r.stream.streamID, r.stream);
              }
            });
            return Array.from(map.values());
          });
        } else if (updateType === 'DELETE') {
          streamList.forEach(streamInfo => {
            const streamID = streamInfo.streamID as string;
            try {
              engine.stopPlayingStream(streamID);
            } catch (e) {
              console.error('stopPlayingStream 失败', streamID, e);
            }
          });

          setRemoteStreams(prev => {
            const deleteSet = new Set(streamList.map(s => s.streamID as string));
            return prev.filter(s => !deleteSet.has(s.streamID));
          });
        }
      }
    );

    return engine;
  }, [appID, server]);

  const handleJoinRoom = useCallback(async () => {
    setError(null);
    if (!roomID || !userID || !userName) {
      setError('roomID、userID、userName 不能为空');
      return;
    }

    try {
      const zg = ensureEngine();
      try {
        const groupAgentEnterUrl = IS_DEV
            ? 'http://localhost:3001/check'
            : 'https://ots-ai-review.appendata.com:8082/check';
        const resp = await fetch(groupAgentEnterUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomID,
          }),
        });
        const json = await resp.json();
        if (json.existRoom){
          message.warning('当前房间号已经录制完成，请修改房间号重新进入');
          return;
        }
      }catch (e){
        console.error('调用 check 接口失败，仅作为警告，不阻塞入会：', e);
      }

      setIsInitializing(true);

      // 如果没有在前端配置 token，则优先从本地 Express 服务获取
      let loginToken = token;
      if (!loginToken) {
        const tokenUrl = IS_DEV
          ? `http://localhost:3001/token?userId=${encodeURIComponent(userID)}`
          : `https://ots-ai-review.appendata.com:8082/token?userId=${encodeURIComponent(userID)}`;
        const resp = await fetch(
          tokenUrl
        );
        if (!resp.ok) {
          throw new Error('从本地服务获取 token 失败');
        }
        const data = (await resp.json()) as { token?: string; code?: number; msg?: string };
        if (!data.token) {
          throw new Error(data.msg || '本地服务未返回 token');
        }
        loginToken = data.token;
      }

      // 创建本地推流（音视频）
      const stream = await zg.createStream({
        camera: {
          audio: true,
          video: false,
        },
      } as any);

      const localStreamID = `${roomID}_${userID}`;
      await zg.loginRoom(
        roomID,
        loginToken,
        { userID, userName } as any,
        { userUpdate: true } as any
      );

      // 在登录房间前，将完整的 RTC 信息（包含用户 streamID）传给本地服务，
      // 由本地服务去调用 CreateGroupAgentInstance / JoinGroupAgentInstance
      try {
        const groupAgentEnterUrl = IS_DEV
          ? 'http://localhost:3001/group-agent/enter'
          : 'https://ots-ai-review.appendata.com:8082/group-agent/enter';
        const resp = await fetch(groupAgentEnterUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomID,
            userID,
            rtcInfo: {
              RoomId: roomID,
              UserStreamId: localStreamID,
            },
          }),
        });
        const json = await resp.json();
        const agentId = json.agentId;
        setAgentId(agentId);

      } catch (e) {
        console.error('调用 group-agent 接口失败，仅作为警告，不阻塞入会：', e);
      }

      zg.startPublishingStream(localStreamID, stream);
      setLocalStream(stream);
      setIsInRoom(true);

      try {
        const startRecordUrl = IS_DEV
            ? 'http://localhost:3001/startRecord'
            : 'https://ots-ai-review.appendata.com:8082/startRecord';
        const resp = await fetch(startRecordUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            roomID,
            isSingle
          }),
        });

        const taskData= await resp.json();
        setTaskId(taskData.taskId);
        setMixedTaskId(taskData.mixedTaskId);
      } catch (e) {
        console.error('调用 startRecord 接口失败，仅作为警告，不阻塞入会：', e);
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || '加入房间失败，请检查配置');
    } finally {
      setIsInitializing(false);
    }
  }, [roomID, userID, userName, ensureEngine, token, isSingle]);

  const handleLeaveRoom = useCallback(async () => {
    const zg = engineRef.current;
    if (!zg) return;

    try {
      // 停止拉取远端流
      remoteStreams.forEach(s => {
        try {
          zg.stopPlayingStream(s.streamID);
        } catch (e) {
          console.error('stopPlayingStream 失败', s.streamID, e);
        }
      });

      if (localStream) {
        const localStreamID = `${roomID}_${userID}`;
        zg.stopPublishingStream(localStreamID);
        zg.destroyStream(localStream as any);
      }
      setLocalStream(null);
      setIsMuted(false);
      setRemoteStreams([]);
      zg.logoutRoom(roomID);

      try {
        const stopRecordUrl = IS_DEV
            ? 'http://localhost:3001/stopRecord'
            : 'https://ots-ai-review.appendata.com:8082/stopRecord';
        await fetch(stopRecordUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            taskId: taskId,
            roomId: roomID,
            agentId,
            mixedTaskId
          }),
        });

        setTaskId(undefined);

      } catch (e) {
        console.error('调用 startRecord 接口失败，仅作为警告，不阻塞入会：', e);
      }

    } catch (e) {
      console.error(e);
    } finally {
      setIsInRoom(false);
    }
  }, [remoteStreams, localStream, roomID, userID, taskId, agentId, mixedTaskId]);

  const handleToggleMute = useCallback(() => {
    if (!localStream) return;
    const nextMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => {
      // 静音：关闭本地音轨；取消静音：重新打开
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }, [isMuted, localStream]);

  // 绑定本地 video 元素
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (engineRef.current) {
        try {
          engineRef.current.destroyEngine();
        } catch (e) {
          console.error(e);
        }
      }
      engineRef.current = null;
    };
  }, []);

  return (
    <div className="zego-app">
      <h1 className="zego-title">Zego 多人音视频通话 Demo</h1>

      <div className="zego-config">
        {/*<div className="zego-config-row">*/}
        {/*  <label>appID：</label>*/}
        {/*  <input*/}
        {/*    type="number"*/}
        {/*    value={appID || ''}*/}
        {/*    onChange={e => setAppID(Number(e.target.value))}*/}
        {/*    placeholder="在控制台获取的 appID（数字）"*/}
        {/*  />*/}
        {/*</div>*/}
        {/*<div className="zego-config-row">*/}
        {/*  <label>server：</label>*/}
        {/*  <input*/}
        {/*    type="text"*/}
        {/*    value={server}*/}
        {/*    onChange={e => setServer(e.target.value)}*/}
        {/*    placeholder="wss://xxx.zego.im/ws"*/}
        {/*  />*/}
        {/*</div>*/}
        <div className="zego-config-row">
          <label>roomID：</label>
          <input
            type="text"
            value={roomID}
            onChange={e => setRoomID(e.target.value)}
          />
        </div>
        <div className="zego-config-row">
          <label>userID：</label>
          <input
            type="text"
            value={userID}
            onChange={e => setUserID(e.target.value)}
          />
        </div>
        <div className="zego-config-row">
          <label>userName：</label>
          <input
            type="text"
            value={userName}
            onChange={e => setUserName(e.target.value)}
          />
        </div>
        <div className="zego-actions">
          <button
            type="button"
            disabled={isInitializing || isInRoom}
            onClick={handleJoinRoom}
          >
            {isInitializing ? '加入中...' : '加入房间'}
          </button>
          <button
            type="button"
            disabled={!isInRoom}
            onClick={async ()=>{
              await handleLeaveRoom();
            }}
            className="danger"
          >
            离开房间
          </button>
          <button
            type="button"
            disabled={!isInRoom || !localStream}
            onClick={handleToggleMute}
          >
            {isMuted ? '取消静音' : '静音'}
          </button>
        </div>

        {error && <div className="zego-error">{error}</div>}
      </div>

      <div className="zego-video-layout">
        <div className="zego-video-panel">
          <h2>本地视频</h2>
          <video
            ref={localVideoRef}
            autoPlay
            muted
            playsInline
            className="zego-video"
          />
        </div>

        <div className="zego-video-panel">
          <h2>远端视频（多人）</h2>
          <div className="zego-remote-grid">
            {remoteStreams.map(stream => (
              <div key={stream.streamID} id={stream.streamID} className="zego-remote-item">
                <video
                  autoPlay
                  playsInline
                  className="zego-video"
                  ref={el => {
                    if (el && stream.mediaStream) {
                      el.srcObject = stream.mediaStream;
                      // 尽量触发播放，避免部分浏览器自动播放策略导致无声/黑屏
                      const p = el.play();
                      if (p && typeof (p as any).catch === 'function') {
                        (p as any).catch(() => {});
                      }
                    }
                  }}
                />
                <div className="zego-remote-info">
                  {stream.userName || stream.userID || stream.streamID}
                </div>
              </div>
            ))}
            {remoteStreams.length === 0 && (
              <div className="zego-empty-text">暂无远端用户加入</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
