class FullCaptureManager {
    constructor() {
        this.videoTrack = null;
        this.audioSources = [];
        this.mixedAudioTrack = null;
        this.canvasStream = null;
        this.finalStream = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.audioContext = null;
        this.observer = null;
    }
    
    async start() {
        // Find the main element
        const mainElement = document.querySelector('main');
        if (!mainElement) {
            console.error('No <main> element found in the DOM');
            return;
        }
        mainElement.style = 'display: block;';

        document.querySelectorAll('body *').forEach(el => el.tagName !== 'VIDEO' && !el.querySelector('video') ? el.style.display = 'none' : '');

        // Get main element dimensions
        const mainRect = mainElement.getBoundingClientRect();
        
        // Create a canvas element with the same dimensions
        const canvas = document.createElement('canvas');
        canvas.width = mainRect.width;
        canvas.height = mainRect.height;
        //canvas.style.display = 'none'; // Hide the canvas
        document.body.appendChild(canvas);
        
        // Find all video elements within the main element
        let videoElements = mainElement.querySelectorAll('video');
        console.log(`Found ${videoElements.length} video elements in main`);
        
        // Set up the canvas context for drawing
        const ctx = canvas.getContext('2d');
        
        // Create a MutationObserver to watch for changes to the DOM
        this.observer = new MutationObserver((mutations) => {
            // Update the list of video elements when DOM changes
            videoElements = mainElement.querySelectorAll('video');
            console.log(`Updated: ${videoElements.length} video elements in main`);
        });
        
        // Start observing the main element for changes
        this.observer.observe(mainElement, { 
            childList: true,      // Watch for added/removed nodes
            subtree: true,        // Watch all descendants
            attributes: false,    // Don't need to watch attributes
            characterData: false  // Don't need to watch text content
        });
        
        // Create a drawing function that runs at 30fps
        const drawVideosToCanvas = () => {
            // Clear the canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw each video in its relative position
            // Use the videoElements variable that's maintained by the MutationObserver
            // instead of querying the DOM on every frame
            videoElements.forEach(video => {
                // Calculate relative position within main element
                const videoRect = video.getBoundingClientRect();
                const relativeX = videoRect.left - mainRect.left;
                const relativeY = videoRect.top - mainRect.top;
                
                // Only draw if the video is playing and has dimensions
                if (!video.paused && video.videoWidth > 0 && video.videoHeight > 0) {
                    ctx.drawImage(
                        video,
                        relativeX,
                        relativeY,
                        videoRect.width,
                        videoRect.height
                    );
                }
            });
            
            // Schedule the next frame
            this.animationFrameId = requestAnimationFrame(drawVideosToCanvas);
        };
        
        // Start the drawing loop
        drawVideosToCanvas();
        
        // Capture the canvas stream (30fps is typical for video conferencing)
        const canvasStream = canvas.captureStream(30);
        const [videoTrack] = canvasStream.getVideoTracks();
        this.videoTrack = videoTrack;
        this.canvas = canvas; // Store canvas reference for cleanup
        
        // Set up audio context and processing as before
        this.audioContext = new AudioContext();

        this.audioSources = globalAudioTracks.map(track => {
            const mediaStream = new MediaStream([track]);
            return this.audioContext.createMediaStreamSource(mediaStream);
        });

        // Create a destination node
        const destination = this.audioContext.createMediaStreamDestination();

        // Connect all sources to the destination
        this.audioSources.forEach(source => source.connect(destination));

        this.mixedAudioTrack = destination.stream.getAudioTracks()[0];

        this.finalStream = new MediaStream([
            this.videoTrack,
            this.mixedAudioTrack
        ]);
        
        // Initialize MediaRecorder with the final stream
        this.startRecording();
    }
    
    startRecording() {
        // Options for better quality
        const options = { mimeType: 'video/mp4' };
        this.mediaRecorder = new MediaRecorder(this.finalStream, options);
        
        this.recordedChunks = [];
        
        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                console.log('ondataavailable', event.data.size);
                window.ws.sendEncodedMP4Chunk(event.data);
            }
        };
        
        this.mediaRecorder.onstop = () => {
            this.saveRecording();
        };
        
        // Start recording, collect data in chunks every 1 second
        this.mediaRecorder.start(1000);
        console.log("Recording started");
    }
    
    stopRecording() {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            console.log("Recording stopped");
        }
    }
    
    stop() {
        this.stopRecording();
        
        // Cancel animation frame if it exists
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        
        // Disconnect the MutationObserver
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        
        // Remove canvas element if it exists
        if (this.canvas) {
            document.body.removeChild(this.canvas);
            this.canvas = null;
        }
        
        // Stop all tracks
        if (this.videoTrack) this.videoTrack.stop();
        if (this.mixedAudioTrack) this.mixedAudioTrack.stop();
        
        // Clean up
        this.videoTrack = null;
        this.mixedAudioTrack = null;
        this.finalStream = null;
        this.mediaRecorder = null;
    }
}

// Video track manager
class VideoTrackManager {
    constructor(ws) {
        this.videoTracks = new Map();
        this.ws = ws;
        this.trackToSendCache = null;
    }

    deleteVideoTrack(videoTrack) {
        this.videoTracks.delete(videoTrack.id);
        this.trackToSendCache = null;
    }

    upsertVideoTrack(videoTrack, streamId, isScreenShare) {
        const existingVideoTrack = this.videoTracks.get(videoTrack.id);

        // Create new object with track info and firstSeenAt timestamp
        const trackInfo = {
            originalTrack: videoTrack,
            isScreenShare: isScreenShare,
            firstSeenAt: existingVideoTrack ? existingVideoTrack.firstSeenAt : Date.now(),
            streamId: streamId
        };
 
        console.log('upsertVideoTrack for', videoTrack.id, '=', trackInfo);
        
        this.videoTracks.set(videoTrack.id, trackInfo);
        this.trackToSendCache = null;
    }

    getStreamIdToSendCached() {
        return this.getTrackToSendCached()?.streamId;
    }

    getTrackToSendCached() {
        if (this.trackToSendCache) {
            return this.trackToSendCache;
        }

        this.trackToSendCache = this.getTrackToSend();
        return this.trackToSendCache;
    }

    getTrackToSend() {
        const screenShareTracks = Array.from(this.videoTracks.values()).filter(track => track.isScreenShare);
        const mostRecentlyCreatedScreenShareTrack = screenShareTracks.reduce((max, track) => {
            return track.firstSeenAt > max.firstSeenAt ? track : max;
        }, screenShareTracks[0]);

        if (mostRecentlyCreatedScreenShareTrack) {
            return mostRecentlyCreatedScreenShareTrack;
        }

        const nonScreenShareTracks = Array.from(this.videoTracks.values()).filter(track => !track.isScreenShare);
        const mostRecentlyCreatedNonScreenShareTrack = nonScreenShareTracks.reduce((max, track) => {
            return track.firstSeenAt > max.firstSeenAt ? track : max;
        }, nonScreenShareTracks[0]);

        if (mostRecentlyCreatedNonScreenShareTrack) {
            return mostRecentlyCreatedNonScreenShareTrack;
        }

        return null;
    }
}

// Caption manager
class CaptionManager {
    constructor(ws) {
        this.captions = new Map();
        this.ws = ws;
    }

    singleCaptionSynced(caption) {
        this.captions.set(caption.captionId, caption);
        this.ws.sendClosedCaptionUpdate(caption);
    }
}

const DEVICE_OUTPUT_TYPE = {
    AUDIO: 1,
    VIDEO: 2
}

// User manager
class UserManager {
    constructor(ws) {
        this.allUsersMap = new Map();
        this.currentUsersMap = new Map();
        this.deviceOutputMap = new Map();

        this.ws = ws;
    }

    deviceForStreamIsActive(streamId) {
        for(const deviceOutput of this.deviceOutputMap.values()) {
            if (deviceOutput.streamId === streamId) {
                return !deviceOutput.disabled;
            }
        }

        return false;
    }

    getDeviceOutput(deviceId, outputType) {
        return this.deviceOutputMap.get(`${deviceId}-${outputType}`);
    }

    updateDeviceOutputs(deviceOutputs) {
        for (const output of deviceOutputs) {
            const key = `${output.deviceId}-${output.deviceOutputType}`; // Unique key combining device ID and output type

            const deviceOutput = {
                deviceId: output.deviceId,
                outputType: output.deviceOutputType, // 1 = audio, 2 = video
                streamId: output.streamId,
                disabled: output.deviceOutputStatus.disabled,
                lastUpdated: Date.now()
            };

            this.deviceOutputMap.set(key, deviceOutput);
        }

        // Notify websocket clients about the device output update
        this.ws.sendJson({
            type: 'DeviceOutputsUpdate',
            deviceOutputs: Array.from(this.deviceOutputMap.values())
        });
    }

    getUserByDeviceId(deviceId) {
        return this.allUsersMap.get(deviceId);
    }

    // constants for meeting status
    MEETING_STATUS = {
        IN_MEETING: 1,
        NOT_IN_MEETING: 6
    }

    getCurrentUsersInMeeting() {
        return Array.from(this.currentUsersMap.values()).filter(user => user.status === this.MEETING_STATUS.IN_MEETING);
    }

    getCurrentUsersInMeetingWhoAreScreenSharing() {
        return this.getCurrentUsersInMeeting().filter(user => user.parentDeviceId);
    }

    singleUserSynced(user) {
      // Create array with new user and existing users, then filter for unique deviceIds
      // keeping the first occurrence (new user takes precedence)
      const allUsers = [...this.currentUsersMap.values(), user];
      const uniqueUsers = Array.from(
        new Map(allUsers.map(user => [user.deviceId, user])).values()
      );
      this.newUsersListSynced(uniqueUsers);
    }

    newUsersListSynced(newUsersListRaw) {
        const newUsersList = newUsersListRaw.map(user => {
            const userStatusMap = {
                1: 'in_meeting',
                6: 'not_in_meeting',
                7: 'removed_from_meeting'
            }

            return {
                ...user,
                humanized_status: userStatusMap[user.status] || "unknown"
            }
        })
        // Get the current user IDs before updating
        const previousUserIds = new Set(this.currentUsersMap.keys());
        const newUserIds = new Set(newUsersList.map(user => user.deviceId));
        const updatedUserIds = new Set([])

        // Update all users map
        for (const user of newUsersList) {
            if (previousUserIds.has(user.deviceId) && JSON.stringify(this.currentUsersMap.get(user.deviceId)) !== JSON.stringify(user)) {
                updatedUserIds.add(user.deviceId);
            }

            this.allUsersMap.set(user.deviceId, {
                deviceId: user.deviceId,
                displayName: user.displayName,
                fullName: user.fullName,
                profile: user.profile,
                status: user.status,
                humanized_status: user.humanized_status,
                parentDeviceId: user.parentDeviceId
            });
        }

        // Calculate new, removed, and updated users
        const newUsers = newUsersList.filter(user => !previousUserIds.has(user.deviceId));
        const removedUsers = Array.from(previousUserIds)
            .filter(id => !newUserIds.has(id))
            .map(id => this.currentUsersMap.get(id));

        // Clear current users map and update with new list
        this.currentUsersMap.clear();
        for (const user of newUsersList) {
            this.currentUsersMap.set(user.deviceId, {
                deviceId: user.deviceId,
                displayName: user.displayName,
                fullName: user.fullName,
                profilePicture: user.profilePicture,
                status: user.status,
                humanized_status: user.humanized_status,
                parentDeviceId: user.parentDeviceId
            });
        }

        const updatedUsers = Array.from(updatedUserIds).map(id => this.currentUsersMap.get(id));

        if (newUsers.length > 0 || removedUsers.length > 0 || updatedUsers.length > 0) {
            this.ws.sendJson({
                type: 'UsersUpdate',
                newUsers: newUsers,
                removedUsers: removedUsers,
                updatedUsers: updatedUsers
            });
        }
    }
}

// Websocket client
class WebSocketClient {
  // Message types
  static MESSAGE_TYPES = {
      JSON: 1,
      VIDEO: 2,
      AUDIO: 3,
      ENCODED_MP4_CHUNK: 4
  };

  constructor() {
      const url = `ws://localhost:${window.initialData.websocketPort}`;
      console.log('WebSocketClient url', url);
      this.ws = new WebSocket(url);
      this.ws.binaryType = 'arraybuffer';
      
      this.ws.onopen = () => {
          console.log('WebSocket Connected');
      };
      
      this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
      };
      
      this.ws.onerror = (error) => {
          console.error('WebSocket Error:', error);
      };
      
      this.ws.onclose = () => {
          console.log('WebSocket Disconnected');
      };

      this.mediaSendingEnabled = false;
      this.lastVideoFrameTime = performance.now();
      this.fillerFrameInterval = null;

      this.lastVideoFrame = this.getBlackFrame();
      this.blackVideoFrame = this.getBlackFrame();
  }

  getBlackFrame() {
    // Create black frame data (I420 format)
    const width = 1920, height = 1080;
    const yPlaneSize = width * height;
    const uvPlaneSize = (width * height) / 4;

    const frameData = new Uint8Array(yPlaneSize + 2 * uvPlaneSize);
    // Y plane (black = 0)
    frameData.fill(0, 0, yPlaneSize);
    // U and V planes (black = 128)
    frameData.fill(128, yPlaneSize);

    return {width, height, frameData};
  }

  currentVideoStreamIsActive() {
    const result = window.userManager?.deviceForStreamIsActive(window.videoTrackManager?.getStreamIdToSendCached());

    // This avoids a situation where we transition from no video stream to video stream and we send a filler frame from the
    // last time we had a video stream and it's not the same as the current video stream.
    if (!result)
        this.lastVideoFrame = this.blackVideoFrame;

    return result;
  }

  startFillerFrameTimer() {
    if (this.fillerFrameInterval) return; // Don't start if already running
    
    this.fillerFrameInterval = setInterval(() => {
        try {
            const currentTime = performance.now();
            if (currentTime - this.lastVideoFrameTime >= 500 && this.mediaSendingEnabled) {                
                // Fix: Math.floor() the milliseconds before converting to BigInt
                const currentTimeMicros = BigInt(Math.floor(currentTime) * 1000);
                const frameToUse = this.currentVideoStreamIsActive() ? this.lastVideoFrame : this.blackVideoFrame;
                //this.sendVideo(currentTimeMicros, '0', frameToUse.width, frameToUse.height, frameToUse.frameData);
            }
        } catch (error) {
            console.error('Error in black frame timer:', error);
        }
    }, 250);
  }

    stopFillerFrameTimer() {
        if (this.fillerFrameInterval) {
            clearInterval(this.fillerFrameInterval);
            this.fillerFrameInterval = null;
        }
    }

  enableMediaSending() {
    this.mediaSendingEnabled = true;
    this.startFillerFrameTimer();
    window.fullCaptureManager.start();
  }

  disableMediaSending() {
    this.mediaSendingEnabled = false;
    this.stopFillerFrameTimer();
    window.fullCaptureManager.stop();
  }

  handleMessage(data) {
      const view = new DataView(data);
      const messageType = view.getInt32(0, true); // true for little-endian
      
      // Handle different message types
      switch (messageType) {
          case WebSocketClient.MESSAGE_TYPES.JSON:
              const jsonData = new TextDecoder().decode(new Uint8Array(data, 4));
              console.log('Received JSON message:', JSON.parse(jsonData));
              break;
          // Add future message type handlers here
          default:
              console.warn('Unknown message type:', messageType);
      }
  }
  
  sendJson(data) {
      if (this.ws.readyState !== WebSocket.OPEN) {
          console.error('WebSocket is not connected');
          return;
      }

      try {
          // Convert JSON to string then to Uint8Array
          const jsonString = JSON.stringify(data);
          const jsonBytes = new TextEncoder().encode(jsonString);
          
          // Create final message: type (4 bytes) + json data
          const message = new Uint8Array(4 + jsonBytes.length);
          
          // Set message type (1 for JSON)
          new DataView(message.buffer).setInt32(0, WebSocketClient.MESSAGE_TYPES.JSON, true);
          
          // Copy JSON data after type
          message.set(jsonBytes, 4);
          
          // Send the binary message
          this.ws.send(message.buffer);
      } catch (error) {
          console.error('Error sending WebSocket message:', error);
          console.error('Message data:', data);
      }
  }

  sendClosedCaptionUpdate(item) {
    if (!this.mediaSendingEnabled)
        return;

    this.sendJson({
        type: 'CaptionUpdate',
        caption: item
    });
  }

  sendEncodedMP4Chunk(encodedMP4Data) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket is not connected for video chunk send', this.ws.readyState);
      return;
    }

    if (!this.mediaSendingEnabled) {
      return;
    }

    try {
      // Create a header with just the message type (4 bytes)
      const headerBuffer = new ArrayBuffer(4);
      const headerView = new DataView(headerBuffer);
      headerView.setInt32(0, WebSocketClient.MESSAGE_TYPES.ENCODED_MP4_CHUNK, true);
      
      // Create a Blob that combines the header and the MP4 data
      const message = new Blob([headerBuffer, encodedMP4Data]);
      
      // Send the combined Blob directly
      this.ws.send(message);
    } catch (error) {
      console.error('Error sending WebSocket video chunk:', error);
    }
  }

  sendAudio(timestamp, streamId, audioData) {
      if (this.ws.readyState !== WebSocket.OPEN) {
          console.error('WebSocket is not connected for audio send', this.ws.readyState);
          return;
      }


      if (!this.mediaSendingEnabled) {
        return;
      }

      try {
          // Create final message: type (4 bytes) + timestamp (8 bytes) + audio data
          const message = new Uint8Array(4 + 8 + 4 + audioData.buffer.byteLength);
          const dataView = new DataView(message.buffer);
          
          // Set message type (3 for AUDIO)
          dataView.setInt32(0, WebSocketClient.MESSAGE_TYPES.AUDIO, true);
          
          // Set timestamp as BigInt64
          dataView.setBigInt64(4, BigInt(timestamp), true);

          // Set streamId length and bytes
          dataView.setInt32(12, streamId, true);

          // Copy audio data after type and timestamp
          message.set(new Uint8Array(audioData.buffer), 16);
          
          // Send the binary message
          this.ws.send(message.buffer);
      } catch (error) {
          console.error('Error sending WebSocket audio message:', error);
      }
  }

  sendVideo(timestamp, streamId, width, height, videoData) {
      if (this.ws.readyState !== WebSocket.OPEN) {
          console.error('WebSocket is not connected for video send', this.ws.readyState);
          return;
      }

      if (!this.mediaSendingEnabled) {
        return;
      }
      
      this.lastVideoFrameTime = performance.now();
      this.lastVideoFrame = {width, height, frameData: videoData};
      
      try {
          // Convert streamId to UTF-8 bytes
          const streamIdBytes = new TextEncoder().encode(streamId);
          
          // Create final message: type (4 bytes) + timestamp (8 bytes) + streamId length (4 bytes) + 
          // streamId bytes + width (4 bytes) + height (4 bytes) + video data
          const message = new Uint8Array(4 + 8 + 4 + streamIdBytes.length + 4 + 4 + videoData.buffer.byteLength);
          const dataView = new DataView(message.buffer);
          
          // Set message type (2 for VIDEO)
          dataView.setInt32(0, WebSocketClient.MESSAGE_TYPES.VIDEO, true);
          
          // Set timestamp as BigInt64
          dataView.setBigInt64(4, BigInt(timestamp), true);

          // Set streamId length and bytes
          dataView.setInt32(12, streamIdBytes.length, true);
          message.set(streamIdBytes, 16);

          // Set width and height
          const streamIdOffset = 16 + streamIdBytes.length;
          dataView.setInt32(streamIdOffset, width, true);
          dataView.setInt32(streamIdOffset + 4, height, true);

          // Copy video data after headers
          message.set(new Uint8Array(videoData.buffer), streamIdOffset + 8);
          
          // Send the binary message
          this.ws.send(message.buffer);
      } catch (error) {
          console.error('Error sending WebSocket video message:', error);
      }
  }
}

// Interceptors

class FetchInterceptor {
    constructor(responseCallback) {
        this.originalFetch = window.fetch;
        this.responseCallback = responseCallback;
        window.fetch = (...args) => this.interceptFetch(...args);
    }

    async interceptFetch(...args) {
        try {
            // Call the original fetch
            const response = await this.originalFetch.apply(window, args);
            
            // Clone the response since it can only be consumed once
            const clonedResponse = response.clone();
            
            // Call the callback with the cloned response
            await this.responseCallback(clonedResponse);
            
            // Return the original response to maintain normal flow
            return response;
        } catch (error) {
            console.error('Error in intercepted fetch:', error);
            throw error;
        }
    }
}
class RTCInterceptor {
    constructor(callbacks) {
        // Store the original RTCPeerConnection
        const originalRTCPeerConnection = window.RTCPeerConnection;
        
        // Store callbacks
        const onPeerConnectionCreate = callbacks.onPeerConnectionCreate || (() => {});
        const onDataChannelCreate = callbacks.onDataChannelCreate || (() => {});
        
        // Override the RTCPeerConnection constructor
        window.RTCPeerConnection = function(...args) {
            // Create instance using the original constructor
            const peerConnection = Reflect.construct(
                originalRTCPeerConnection, 
                args
            );
            
            // Notify about the creation
            onPeerConnectionCreate(peerConnection);
            
            // Override createDataChannel
            const originalCreateDataChannel = peerConnection.createDataChannel.bind(peerConnection);
            peerConnection.createDataChannel = (label, options) => {
                const dataChannel = originalCreateDataChannel(label, options);
                onDataChannelCreate(dataChannel, peerConnection);
                return dataChannel;
            };
            
            return peerConnection;
        };
    }
}

// Message type definitions
const messageTypes = [
      {
        name: 'CollectionEvent',
        fields: [
            { name: 'body', fieldNumber: 1, type: 'message', messageType: 'CollectionEventBody' }
        ]
    },
    {
        name: 'CollectionEventBody',
        fields: [
            { name: 'userInfoListWrapperAndChatWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapperWrapper' }
        ]
    },
    {
        name: 'UserInfoListWrapperAndChatWrapperWrapper',
        fields: [
            { name: 'deviceInfoWrapper', fieldNumber: 3, type: 'message', messageType: 'DeviceInfoWrapper' },
            { name: 'userInfoListWrapperAndChatWrapper', fieldNumber: 13, type: 'message', messageType: 'UserInfoListWrapperAndChatWrapper' }
        ]
    },
    {
        name: 'UserInfoListWrapperAndChatWrapper',
        fields: [
            { name: 'userInfoListWrapper', fieldNumber: 1, type: 'message', messageType: 'UserInfoListWrapper' },
            { name: 'chatMessageWrapper', fieldNumber: 4, type: 'message', messageType: 'ChatMessageWrapper', repeated: true }
        ]
    },
    {
        name: 'DeviceInfoWrapper',
        fields: [
            { name: 'deviceOutputInfoList', fieldNumber: 2, type: 'message', messageType: 'DeviceOutputInfoList', repeated: true }
        ]
    },
    {
        name: 'DeviceOutputInfoList',
        fields: [
            { name: 'deviceOutputType', fieldNumber: 2, type: 'varint' }, // Speculating that 1 = audio, 2 = video
            { name: 'streamId', fieldNumber: 4, type: 'string' },
            { name: 'deviceId', fieldNumber: 6, type: 'string' },
            { name: 'deviceOutputStatus', fieldNumber: 10, type: 'message', messageType: 'DeviceOutputStatus' }
        ]
    },
    {
        name: 'DeviceOutputStatus',
        fields: [
            { name: 'disabled', fieldNumber: 1, type: 'varint' }
        ]
    },
    // Existing message types
    {
        name: 'UserInfoListResponse',
        fields: [
            { name: 'userInfoListWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperWrapper' }
        ]
    },
    {
        name: 'UserInfoListResponse',
        fields: [
            { name: 'userInfoListWrapperWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapperWrapper' }
        ]
    },
    {
        name: 'UserInfoListWrapperWrapper',
        fields: [
            { name: 'userInfoListWrapper', fieldNumber: 2, type: 'message', messageType: 'UserInfoListWrapper' }
        ]
    },
    {
        name: 'UserEventInfo',
        fields: [
            { name: 'eventNumber', fieldNumber: 1, type: 'varint' } // sequence number for the event
        ]
    },
    {
        name: 'UserInfoListWrapper',
        fields: [
            { name: 'userEventInfo', fieldNumber: 1, type: 'message', messageType: 'UserEventInfo' },
            { name: 'userInfoList', fieldNumber: 2, type: 'message', messageType: 'UserInfoList', repeated: true }
        ]
    },
    {
        name: 'UserInfoList',
        fields: [
            { name: 'deviceId', fieldNumber: 1, type: 'string' },
            { name: 'fullName', fieldNumber: 2, type: 'string' },
            { name: 'profilePicture', fieldNumber: 3, type: 'string' },
            { name: 'status', fieldNumber: 4, type: 'varint' }, // in meeting = 1 vs not in meeting = 6. kicked out = 7?
            { name: 'displayName', fieldNumber: 29, type: 'string' },
            { name: 'parentDeviceId', fieldNumber: 21, type: 'string' } // if this is present, then this is a screenshare device. The parentDevice is the person that is sharing
        ]
    },
    {
        name: 'CaptionWrapper',
        fields: [
            { name: 'caption', fieldNumber: 1, type: 'message', messageType: 'Caption' }
        ]
    },
    {
        name: 'Caption',
        fields: [
            { name: 'deviceId', fieldNumber: 1, type: 'string' },
            { name: 'captionId', fieldNumber: 2, type: 'int64' },
            { name: 'version', fieldNumber: 3, type: 'int64' },
            { name: 'text', fieldNumber: 6, type: 'string' },
            { name: 'languageId', fieldNumber: 8, type: 'int64' }
        ]
    },
    {
        name: 'ChatMessageWrapper',
        fields: [
            { name: 'chatMessage', fieldNumber: 2, type: 'message', messageType: 'ChatMessage' }
        ]
    },
    {
        name: 'ChatMessage',
        fields: [
            { name: 'messageId', fieldNumber: 1, type: 'string' },
            { name: 'deviceId', fieldNumber: 2, type: 'string' },
            { name: 'timestamp', fieldNumber: 3, type: 'int64' },
            { name: 'chatMessageContent', fieldNumber: 5, type: 'message', messageType: 'ChatMessageContent' }
        ]
    },
    {
        name: 'ChatMessageContent',
        fields: [
            { name: 'text', fieldNumber: 1, type: 'string' }
        ]
    }
];

// Generic message decoder factory
function createMessageDecoder(messageType) {
    return function decode(reader, length) {
        if (!(reader instanceof protobuf.Reader)) {
            reader = protobuf.Reader.create(reader);
        }

        const end = length === undefined ? reader.len : reader.pos + length;
        const message = {};

        while (reader.pos < end) {
            const tag = reader.uint32();
            const fieldNumber = tag >>> 3;
            
            const field = messageType.fields.find(f => f.fieldNumber === fieldNumber);
            if (!field) {
                reader.skipType(tag & 7);
                continue;
            }

            let value;
            switch (field.type) {
                case 'string':
                    value = reader.string();
                    break;
                case 'int64':
                    value = reader.int64();
                    break;
                case 'varint':
                    value = reader.uint32();
                    break;
                case 'message':
                    value = messageDecoders[field.messageType](reader, reader.uint32());
                    break;
                default:
                    reader.skipType(tag & 7);
                    continue;
            }

            if (field.repeated) {
                if (!message[field.name]) {
                    message[field.name] = [];
                }
                message[field.name].push(value);
            } else {
                message[field.name] = value;
            }
        }

        return message;
    };
}

const ws = new WebSocketClient();
window.ws = ws;
const userManager = new UserManager(ws);
const captionManager = new CaptionManager(ws);
const videoTrackManager = new VideoTrackManager(ws);
const fullCaptureManager = new FullCaptureManager();
window.videoTrackManager = videoTrackManager;
window.userManager = userManager;
window.fullCaptureManager = fullCaptureManager;
// Create decoders for all message types
const messageDecoders = {};
messageTypes.forEach(type => {
    messageDecoders[type.name] = createMessageDecoder(type);
});

function base64ToUint8Array(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

const syncMeetingSpaceCollectionsUrl = "https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections";
const userMap = new Map();
new FetchInterceptor(async (response) => {
    if (response.url === syncMeetingSpaceCollectionsUrl) {
        const responseText = await response.text();
        const decodedData = base64ToUint8Array(responseText);
        const userInfoListResponse = messageDecoders['UserInfoListResponse'](decodedData);
        const userInfoList = userInfoListResponse.userInfoListWrapperWrapper?.userInfoListWrapper?.userInfoList || [];
        console.log('userInfoList', userInfoList);
        if (userInfoList.length > 0) {
            userManager.newUsersListSynced(userInfoList);
        }
    }
});

const handleCollectionEvent = (event) => {
  const decodedData = pako.inflate(new Uint8Array(event.data));
  //console.log(' handleCollectionEventdecodedData', decodedData);
  // Convert decoded data to base64
  const base64Data = btoa(String.fromCharCode.apply(null, decodedData));
  //console.log('Decoded collection event data (base64):', base64Data);

  const collectionEvent = messageDecoders['CollectionEvent'](decodedData);
  
  const deviceOutputInfoList = collectionEvent.body.userInfoListWrapperAndChatWrapperWrapper?.deviceInfoWrapper?.deviceOutputInfoList;
  if (deviceOutputInfoList) {
    userManager.updateDeviceOutputs(deviceOutputInfoList);
  }

  const chatMessageWrapper = collectionEvent.body.userInfoListWrapperAndChatWrapperWrapper?.userInfoListWrapperAndChatWrapper?.chatMessageWrapper;
  if (chatMessageWrapper) {
    console.log('chatMessageWrapper', chatMessageWrapper);
  }

  //console.log('deviceOutputInfoList', JSON.stringify(collectionEvent.body.userInfoListWrapperAndChatWrapperWrapper?.deviceInfoWrapper?.deviceOutputInfoList));
  //console.log('usermap', userMap.allUsersMap);
  //console.log('userInfoList And Event', collectionEvent.body.userInfoListWrapperAndChatWrapperWrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper);
  const userInfoList = collectionEvent.body.userInfoListWrapperAndChatWrapperWrapper.userInfoListWrapperAndChatWrapper.userInfoListWrapper?.userInfoList || [];
  console.log('userInfoList in collection event', userInfoList);
  // This event is triggered when a single user joins (or leaves) the meeting
  // generally this array only contains a single user
  // we can't tell whether the event is a join or leave event, so we'll assume it's a join
  // if it's a leave, then we'll pick it up from the periodic call to syncMeetingSpaceCollections
  // so there will be a lag of roughly a minute for leave events
  for (const user of userInfoList) {
    userManager.singleUserSynced(user);
  }
};

// the stream ID, not the track id in the TRACK appears in the payload of the protobuf message somewhere

const handleCaptionEvent = (event) => {
  const decodedData = new Uint8Array(event.data);
  const captionWrapper = messageDecoders['CaptionWrapper'](decodedData);
  const caption = captionWrapper.caption;
  captionManager.singleCaptionSynced(caption);
}

const handleMediaDirectorEvent = (event) => {
  console.log('handleMediaDirectorEvent', event);
  const decodedData = new Uint8Array(event.data);
  //console.log(' handleCollectionEventdecodedData', decodedData);
  // Convert decoded data to base64
  const base64Data = btoa(String.fromCharCode.apply(null, decodedData));
  console.log('Decoded media director event data (base64):', base64Data);
}

const globalAudioTracks = [];
const handleAudioTrack = async (event) => {
    globalAudioTracks.push(event.track);
    return;
};

new RTCInterceptor({
    onPeerConnectionCreate: (peerConnection) => {
        console.log('New RTCPeerConnection created:', peerConnection);
        peerConnection.addEventListener('datachannel', (event) => {
            console.log('datachannel', event);
            if (event.channel.label === "collections") {               
                event.channel.addEventListener("message", (messageEvent) => {
                    console.log('RAWcollectionsevent', messageEvent);
                    handleCollectionEvent(messageEvent);
                });
            }
        });

        peerConnection.addEventListener('track', (event) => {
            // Log the track and its associated streams
            if (event.track.kind === 'audio' || event.track.kind === 'video') {
            console.log('New track:', {
                trackId: event.track.id,
                streams: event.streams,
                streamIds: event.streams.map(stream => stream.id),
                // Get any msid information
                transceiver: event.transceiver,
                // Get the RTP parameters which might contain stream IDs
                rtpParameters: event.transceiver?.sender.getParameters()
            });
        }
            if (event.track.kind === 'audio') {
                handleAudioTrack(event);
            }
            if (event.track.kind === 'video') {
                //handleVideoTrack(event);
            }
        });

        // Log the signaling state changes
        peerConnection.addEventListener('signalingstatechange', () => {
            console.log('Signaling State:', peerConnection.signalingState);
        });

        // Log the SDP being exchanged
        const originalSetLocalDescription = peerConnection.setLocalDescription;
        peerConnection.setLocalDescription = function(description) {
            console.log('Local SDP:', description);
            return originalSetLocalDescription.apply(this, arguments);
        };

        const originalSetRemoteDescription = peerConnection.setRemoteDescription;
        peerConnection.setRemoteDescription = function(description) {
            console.log('Remote SDP:', description);
            return originalSetRemoteDescription.apply(this, arguments);
        };

        // Log ICE candidates
        peerConnection.addEventListener('icecandidate', (event) => {
            if (event.candidate) {
                console.log('ICE Candidate:', event.candidate);
            }
        });
    },
    onDataChannelCreate: (dataChannel, peerConnection) => {
        console.log('New DataChannel created:', dataChannel);
        console.log('On PeerConnection:', peerConnection);
        console.log('Channel label:', dataChannel.label);

        //if (dataChannel.label === 'collections') {
          //  dataChannel.addEventListener("message", (event) => {
         //       console.log('collectionsevent', event)
        //    });
        //}


      if (dataChannel.label === 'media-director') {
        dataChannel.addEventListener("message", (mediaDirectorEvent) => {
            handleMediaDirectorEvent(mediaDirectorEvent);
        });
      }

       if (dataChannel.label === 'captions') {
            dataChannel.addEventListener("message", (captionEvent) => {
                handleCaptionEvent(captionEvent);
            });
        }
    }
});