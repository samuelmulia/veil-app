"use client";

import React, { useEffect, useState, SVGProps, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Room,
  RoomEvent,
  Participant,
  ConnectionState,
  DataPacket_Kind,
} from 'livekit-client';
import { AnimatePresence, motion } from 'framer-motion';

// --- Voice Options Data ---
const voiceOptions = [
    { id: 'original', name: 'Original Voice' },
    { id: 'agent_alpha', name: 'Agent Alpha (Deep)' },
    { id: 'agent_delta', name: 'Agent Delta (High)' },
    { id: 'synthetic', name: 'Synthetic (Robot)' },
    { id: 'spectral', name: 'Spectral (Radio)' },
];

// --- Types ---
type VoiceNote = {
    id: string;
    sender: string;
    audioUrl: string;
    timestamp: number;
    isPlaying: boolean;
};

type Packet = 
    | { type: 'voice-note', effectId: string, audioData: string } // Base64 encoded
    | { type: 'status', status: 'recording' | 'idle' };

// --- Base64 Helpers ---
function arrayBufferToBase64(buffer: ArrayBuffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64: string) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}


// --- Audio Processing Utility ---
async function applyVoiceEffect(audioBuffer: ArrayBuffer, effectId: string): Promise<Blob> {
    const audioContext = new AudioContext();
    const sourceAudioBuffer = await audioContext.decodeAudioData(audioBuffer.slice(0));

    if (effectId === 'original') {
        const wavBuffer = bufferToWav(sourceAudioBuffer);
        return new Blob([wavBuffer], { type: 'audio/wav' });
    }

    const offlineContext = new OfflineAudioContext(
        sourceAudioBuffer.numberOfChannels,
        sourceAudioBuffer.length,
        sourceAudioBuffer.sampleRate
    );

    const source = offlineContext.createBufferSource();
    source.buffer = sourceAudioBuffer;
    
    let pitchRate = 1.0;
    let filter: BiquadFilterNode | null = null;
    let lastNode: AudioNode = source;

    switch (effectId) {
        case 'agent_alpha': pitchRate = 0.75; break;
        case 'agent_delta': pitchRate = 1.5; break;
        case 'synthetic':
            pitchRate = 0.9;
            filter = offlineContext.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 1000;
            break;
        case 'spectral':
            filter = offlineContext.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 1500;
            filter.Q.value = 5;
            break;
    }

    source.playbackRate.value = pitchRate;

    if (filter) {
        lastNode.connect(filter);
        lastNode = filter;
    }
    
    lastNode.connect(offlineContext.destination);
    
    source.start(0);
    const renderedBuffer = await offlineContext.startRendering();
    const wavBuffer = bufferToWav(renderedBuffer);
    return new Blob([wavBuffer], { type: 'audio/wav' });
}

function bufferToWav(abuffer: AudioBuffer): ArrayBuffer {
    const numOfChan = abuffer.numberOfChannels;
    const length = abuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    // FIX: Moved channel declaration to the top of the function
    const channels: Float32Array[] = [];
    let i, sample, offset = 0, pos = 0;

    // write WAVE header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8);
    setUint32(0x45564157); // "WAVE"
    setUint32(0x20746d66); // "fmt "
    setUint32(16);
    setUint16(1);
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2);
    setUint16(16);
    setUint32(0x61746164); // "data"
    setUint32(length - pos - 4);

    for (i = 0; i < abuffer.numberOfChannels; i++) {
        channels.push(abuffer.getChannelData(i));
    }

    while (pos < length) {
        for (i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset++;
    }
    return buffer;

    function setUint16(data: number) { view.setUint16(pos, data, true); pos += 2; }
    function setUint32(data: number) { view.setUint32(pos, data, true); pos += 4; }
}

// --- Main Page Component ---
export default function VoiceNotesPage({ params }: { params: { roomName:string } }) {
    const [isInLobby, setIsInLobby] = useState(true);
    const [room, setRoom] = useState<Room | undefined>(undefined);
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
    const [connectionNotification, setConnectionNotification] = useState<string | null>(null);
    const [recordingParticipants, setRecordingParticipants] = useState<Record<string, boolean>>({});
    
    const [recordingStatus, setRecordingStatus] = useState<'idle' | 'recording' | 'reviewing' | 'sending'>('idle');
    const [lastRecording, setLastRecording] = useState<{ blob: Blob | null, url: string | null }>({ blob: null, url: null });

    const [selectedVoice, setSelectedVoice] = useState('original');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    
    const router = useRouter();
    const roomName = params.roomName;
    
    const handleEnterRoom = async () => {
        setConnectionError(null);
        const identity = `user-${Math.random().toString(36).substring(7).slice(0, 5)}`;
        
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });

            const resp = await fetch(`/api/token?roomName=${roomName}&identity=${identity}`);
            if (!resp.ok) {
                const errorData = await resp.json().catch(() => ({ message: 'Failed to get access token.' }));
                throw new Error(errorData.message || 'Failed to get access token.');
            }
            const { token } = await resp.json();

            const newRoom = new Room();
            const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
            if (!wsUrl) throw new Error("LiveKit URL is not configured.");
            
            await newRoom.connect(wsUrl, token);
            setRoom(newRoom);
            setIsInLobby(false);
        } catch (error: any) {
            console.error("Error connecting to LiveKit:", error);
            if (error.name === 'NotFoundError' || error.name === 'NotAllowedError') {
                setConnectionError('Microphone access denied. Please allow access in browser settings.');
            } else {
                setConnectionError(error.message || 'An unexpected error occurred.');
            }
        }
    };
    
    useEffect(() => {
        if (!room) return;
        
        const showNotification = (message: string) => {
            setConnectionNotification(message);
            setTimeout(() => setConnectionNotification(null), 3000);
        }

        const handleParticipantUpdate = () => {
             setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
        };

        const handleParticipantConnected = (participant: Participant) => {
            showNotification(`${participant.identity} has joined.`);
            handleParticipantUpdate();
        };

        const handleParticipantDisconnected = (participant: Participant) => {
            showNotification(`${participant.identity} has left.`);
            handleParticipantUpdate();
            setRecordingParticipants(prev => {
                const newState = {...prev};
                delete newState[participant.identity];
                return newState;
            })
        };

        const handleDataReceived = async (payload: Uint8Array, participant?: Participant) => {
            if (!participant) return;

            try {
                const decoder = new TextDecoder();
                const packet = JSON.parse(decoder.decode(payload)) as Packet;
                
                if(packet.type === 'voice-note'){
                    const audioBuffer = base64ToArrayBuffer(packet.audioData);
                    const processedBlob = await applyVoiceEffect(audioBuffer, packet.effectId);
                    const audioUrl = URL.createObjectURL(processedBlob);
                    const newNote: VoiceNote = {
                        id: `vn-${Date.now()}-${Math.random()}`,
                        sender: participant.identity,
                        audioUrl,
                        timestamp: Date.now(),
                        isPlaying: false
                    };
                    setVoiceNotes(prev => [newNote, ...prev]);
                } else if (packet.type === 'status') {
                    setRecordingParticipants(prev => ({...prev, [participant.identity]: packet.status === 'recording'}));
                }
            } catch (error) {
                console.error('Error processing received data:', error);
            }
        };

        handleParticipantUpdate();
        room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
        room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
        room.on(RoomEvent.DataReceived, handleDataReceived);

        return () => {
            room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
            room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
            room.off(RoomEvent.DataReceived, handleDataReceived);
        };
    }, [room]);

    const broadcastStatus = useCallback(async (status: 'recording' | 'idle') => {
        if (!room) return;
        try {
            const packet: Packet = { type: 'status', status };
            const encoder = new TextEncoder();
            const data = encoder.encode(JSON.stringify(packet));
            await room.localParticipant.publishData(data, { reliable: true });
        } catch(error) {
            console.error("Failed to broadcast status:", error);
        }
    }, [room]);

    const handleStartRecording = async () => {
        setRecordingStatus('recording');
        broadcastStatus('recording');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            audioChunksRef.current = [];
            mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
            mediaRecorderRef.current.onstop = () => {
                broadcastStatus('idle');
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const audioUrl = URL.createObjectURL(audioBlob);
                setLastRecording({ blob: audioBlob, url: audioUrl });
                setRecordingStatus('reviewing');
                stream.getTracks().forEach(track => track.stop());
            };
            mediaRecorderRef.current.start();
        } catch (error) {
            console.error("Error starting recording:", error);
            setConnectionError("Could not start recording.");
            setRecordingStatus('idle');
            broadcastStatus('idle');
        }
    };

    const handleStopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
    };
    
    const handleSendNote = async () => {
        if (!lastRecording.blob || !room) return;
        setRecordingStatus('sending');
        try {
            const arrayBuffer = await lastRecording.blob.arrayBuffer();
            const base64Audio = arrayBufferToBase64(arrayBuffer);
            const packet: Packet = {
                type: 'voice-note',
                effectId: selectedVoice,
                audioData: base64Audio,
            };
            const encoder = new TextEncoder();
            const data = encoder.encode(JSON.stringify(packet));
            await room.localParticipant.publishData(data, { reliable: true });
        } catch (error) {
            console.error("Error sending voice note:", error);
            setConnectionError("Failed to send voice note.");
        } finally {
            setRecordingStatus('idle');
            if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
            setLastRecording({ blob: null, url: null });
        }
    };

    const handleDiscardNote = () => {
        if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
        setLastRecording({ blob: null, url: null });
        setRecordingStatus('idle');
        broadcastStatus('idle');
    };

    const handlePlayPause = (noteId: string) => {
        const noteToPlay = voiceNotes.find(n => n.id === noteId);
        if (!noteToPlay) return;

        if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
            audioPlayerRef.current.pause();
            if (audioPlayerRef.current.src === noteToPlay.audioUrl) {
                setVoiceNotes(prev => prev.map(n => ({ ...n, isPlaying: false })));
                return;
            }
        }
        
        const newAudio = new Audio(noteToPlay.audioUrl);
        audioPlayerRef.current = newAudio;
        newAudio.onplay = () => setVoiceNotes(prev => prev.map(n => n.id === noteId ? {...n, isPlaying: true} : {...n, isPlaying: false}));
        newAudio.onpause = newAudio.onended = () => setVoiceNotes(prev => prev.map(n => n.id === noteId ? {...n, isPlaying: false} : n));
        newAudio.play();
    };

    return (
        <div className="bg-[#080808] text-white min-h-screen flex flex-col">
            <ConnectionNotification message={connectionNotification} />
            {isInLobby ? (
                <Lobby 
                  onEnterRoom={handleEnterRoom} 
                  connectionError={connectionError}
                  roomName={roomName}
                  isConnecting={room?.state === ConnectionState.Connecting}
                  selectedVoice={selectedVoice}
                  setSelectedVoice={setSelectedVoice}
                />
            ) : (
                <InCall
                    roomName={roomName}
                    participants={participants}
                    voiceNotes={voiceNotes}
                    recordingStatus={recordingStatus}
                    onStartRecording={handleStartRecording}
                    onStopRecording={handleStopRecording}
                    onSendNote={handleSendNote}
                    onDiscardNote={handleDiscardNote}
                    lastRecordingUrl={lastRecording.url}
                    onPlayPause={handlePlayPause}
                    localParticipant={room?.localParticipant}
                    recordingParticipants={recordingParticipants}
                />
            )}
        </div>
    );
}

// --- UI Components ---
const Lobby = ({ onEnterRoom, connectionError, roomName, isConnecting, selectedVoice, setSelectedVoice }: any) => {
  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-[#111] p-8 rounded-2xl flex flex-col border border-[#222]">
          <h2 className="text-2xl font-bold mb-2 text-center">Voice Notes Room</h2>
          <p className="text-center text-gray-400 mb-8">Room: <span className="font-bold text-white">{roomName}</span></p>
            <div className="mb-8 flex-grow">
                <h3 className="text-lg font-semibold mb-3 text-center">Choose Your Anonymous Voice</h3>
                <VoiceOptions selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
            </div>
            {connectionError && (
              <div className="bg-red-900/50 border border-red-500/50 text-red-200 p-3 rounded-lg mb-4 text-sm text-center">
                <strong>Connection Failed:</strong> {connectionError}
              </div>
            )}
            <button onClick={onEnterRoom} disabled={isConnecting} className="btn-primary w-full font-bold py-4 rounded-xl text-lg disabled:opacity-50 disabled:cursor-not-allowed">
              {isConnecting ? 'Connecting...' : 'Join Room'}
            </button>
        </div>
      </div>
    </div>
  );
};

const InCall = ({ roomName, participants, voiceNotes, recordingStatus, onStartRecording, onStopRecording, onSendNote, onDiscardNote, lastRecordingUrl, onPlayPause, localParticipant, recordingParticipants }: any) => {
    const reviewPlayerRef = useRef<HTMLAudioElement>(null);
    const hasPeers = participants.length > 1;

    const playReview = () => {
        if(reviewPlayerRef.current) reviewPlayerRef.current.play();
    }

    return (
        <div className="flex-1 flex flex-col p-4 md:p-6 max-w-4xl mx-auto w-full">
            <header className="mb-6">
                 <h1 className="text-3xl font-bold text-white">Voice Notes</h1>
                 <p className="text-gray-400">You are <span className="font-mono bg-[#222] px-2 py-1 rounded">{localParticipant?.identity}</span> in room <span className="font-bold text-white">{roomName}</span></p>
                 <div className="text-gray-400 text-sm mt-2">
                    <span className="font-bold">Participants:</span>
                    {participants.map((p: Participant) => (
                        <span key={p.sid} className="ml-2">
                            {p.identity}
                            {recordingParticipants[p.identity] && <span className="ml-2 text-red-500 font-bold animate-pulse">REC</span>}
                        </span>
                    ))}
                 </div>
            </header>
            <div className="flex-1 bg-[#111] rounded-2xl p-4 overflow-y-auto mb-6 border border-[#222]">
                <AnimatePresence>
                    {!hasPeers && recordingStatus === 'idle' && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full text-gray-500">
                            <UsersIcon className="w-16 h-16 mb-4" />
                            <p className="font-bold">Waiting for others to join...</p>
                        </motion.div>
                    )}
                    {hasPeers && voiceNotes.length === 0 && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full text-gray-500">
                            <MessageSquareIcon className="w-16 h-16 mb-4" />
                            <p>No voice notes yet. Press the mic to start.</p>
                        </motion.div>
                    )}
                    {voiceNotes.map((note: VoiceNote) => (
                        <motion.div 
                            key={note.id}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            layout
                            className="flex items-center space-x-4 p-3 mb-2 bg-[#222] rounded-lg"
                        >
                            <button onClick={() => onPlayPause(note.id)} className={`p-3 rounded-full transition-colors ${note.isPlaying ? 'bg-yellow-500' : 'bg-blue-600 hover:bg-blue-500'}`}>
                                {note.isPlaying ? <PauseIcon className="w-5 h-5 text-white" /> : <PlayIcon className="w-5 h-5 text-white" />}
                            </button>
                            <div className="flex-1">
                                <p className="font-bold text-white">{note.sender}</p>
                                <p className="text-xs text-gray-400">{new Date(note.timestamp).toLocaleTimeString()}</p>
                            </div>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
            <footer className="flex justify-center items-center p-4 h-32">
                {recordingStatus === 'idle' && (
                    <button onClick={onStartRecording} className="record-btn idle w-24 h-24 rounded-full flex items-center justify-center transition-all duration-200 ease-in-out">
                        <MicIcon className="w-10 h-10 text-white" />
                    </button>
                )}
                {recordingStatus === 'recording' && (
                    <button onClick={onStopRecording} className="record-btn recording w-24 h-24 rounded-full flex items-center justify-center transition-all">
                        <StopIcon className="w-10 h-10 text-white" />
                    </button>
                )}
                 {recordingStatus === 'reviewing' && (
                    <div className="flex items-center gap-4">
                        <button onClick={onDiscardNote} className="bg-gray-600 hover:bg-gray-500 p-4 rounded-full"><XIcon className="w-6 h-6 text-white"/></button>
                        {lastRecordingUrl && <audio ref={reviewPlayerRef} src={lastRecordingUrl} />}
                        <button onClick={playReview} className="bg-blue-600 hover:bg-blue-500 p-5 rounded-full"><PlayIcon className="w-8 h-8 text-white"/></button>
                        <button onClick={onSendNote} className="bg-green-600 hover:bg-green-500 p-4 rounded-full"><SendIcon className="w-6 h-6 text-white"/></button>
                    </div>
                )}
                {recordingStatus === 'sending' && (
                     <div className="text-gray-400">Sending...</div>
                )}
            </footer>
             <style jsx>{`
                .record-btn.idle { background: #1e40af; }
                .record-btn.recording {
                    background: #dc2626;
                    animation: pulse-red 2s infinite;
                }
                @keyframes pulse-red {
                    0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7); }
                    70% { box-shadow: 0 0 0 25px rgba(220, 38, 38, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); }
                }
            `}</style>
        </div>
    );
};

const ConnectionNotification = ({ message }: { message: string | null }) => {
    return (
        <AnimatePresence>
            {message && (
                <motion.div
                    initial={{ y: -100, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -100, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    className="absolute top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg z-50"
                >
                    {message}
                </motion.div>
            )}
        </AnimatePresence>
    );
};


const VoiceOptions = React.memo(function VoiceOptions({ selectedVoice, setSelectedVoice }: any) {
    return (
        <div className="space-y-2">
            {voiceOptions.map((option) => (
                <div
                    key={option.id}
                    onClick={() => setSelectedVoice(option.id)}
                    className={`voice-option cursor-pointer p-3 rounded-lg border-l-4 flex items-center justify-between transition-colors ${selectedVoice === option.id ? 'selected bg-[#2a2a2a] border-white' : 'border-transparent hover:bg-[#1a1a1a]'}`}
                >
                    <span>{option.name}</span>
                    <MicIcon className="w-5 h-5 text-gray-400" />
                </div>
            ))}
        </div>
    );
});


// --- SVG Icons ---
const MicIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path> </svg> );
const PlayIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M8 5v14l11-7z"></path> </svg> );
const PauseIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path> </svg> );
const StopIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M6 6h12v12H6z"></path> </svg> );
const SendIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path> </svg> );
const XIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path> </svg> );
const MessageSquareIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path> </svg> );
const UsersIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18v-5.25m0 0a3 3 0 00-3-3m3 3a3 3 0 00-3-3m-3 3a3 3 0 00-3-3m3 3a3 3 0 00-3-3m-3 3a3 3 0 00-3-3m3 3a3 3 0 00-3-3m0 9.75V18m0-9.75a3 3 0 013-3m-3 3a3 3 0 00-3 3m3-3a3 3 0 013-3m-3 3a3 3 0 00-3 3m6.75 3.375c.621 1.278 1.694 2.34 2.873 3.118a48.455 48.455 0 01-5.746 0c1.179-.778 2.252-1.84 2.873-3.118z"></path></svg>);

