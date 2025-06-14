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

// --- Constants ---
const CHUNK_SIZE = 60 * 1024; // 60 KB

// --- Voice Options Data ---
const voiceOptions = [
    { id: 'budi', name: 'Budi' },
    { id: 'joko', name: 'Joko' },
    { id: 'agung', name: 'Agung' },
    { id: 'citra', name: 'Citra' },
    { id: 'rini', name: 'Rini' },
];

// --- Types ---
type NoteStatus = 'sent' | 'delivered' | 'played';
type VoiceNote = {
    id: string;
    sender: { id: string; name: string };
    audioUrl: string;
    timestamp: number;
    isPlaying: boolean;
    status: NoteStatus;
};

type Packet = 
    | { type: 'voice-chunk', noteId: string, chunk: string, index: number, total: number }
    | { type: 'status', status: 'recording' | 'idle' }
    | { type: 'delete-note', noteId: string }
    | { type: 'status-update', noteId: string, status: NoteStatus };

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

// --- Main Page Component ---
export default function VoiceNotesPage({ params }: { params: { roomName:string } }) {
    const [isInLobby, setIsInLobby] = useState(true);
    const [room, setRoom] = useState<Room | undefined>(undefined);
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
    const [connectionNotification, setConnectionNotification] = useState<string | null>(null);
    const [recordingParticipants, setRecordingParticipants] = useState<Record<string, boolean>>({});
    
    const [recordingStatus, setRecordingStatus] = useState<'idle' | 'recording' | 'reviewing' | 'sending' | 'processing'>('idle');
    const [lastRecording, setLastRecording] = useState<{ blob: Blob | null, url: string | null }>({ blob: null, url: null });

    const [selectedVoice, setSelectedVoice] = useState('budi');
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const receivedChunksRef = useRef<Record<string, string[]>>({});
    
    const router = useRouter();
    const roomName = params.roomName;

    const bufferToWav = useCallback((abuffer: AudioBuffer): ArrayBuffer => {
        const numOfChan = abuffer.numberOfChannels,
            length = abuffer.length * numOfChan * 2 + 44,
            buffer = new ArrayBuffer(length),
            view = new DataView(buffer),
            channels: Float32Array[] = [];
        let i, sample, offset = 0, pos = 0;

        const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; }
        const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; }

        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
        setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
        setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan);
        setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164);
        setUint32(length - pos - 4);

        for (i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));
        
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
    }, []);

    const applyVoiceEffect = useCallback(async (audioBlob: Blob, effectId: string): Promise<Blob> => {
        const audioContext = new AudioContext();
        const arrayBuffer = await audioBlob.arrayBuffer();
        const sourceAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
        const offlineContext = new OfflineAudioContext(
            sourceAudioBuffer.numberOfChannels,
            sourceAudioBuffer.length,
            sourceAudioBuffer.sampleRate
        );
    
        const source = offlineContext.createBufferSource();
        source.buffer = sourceAudioBuffer;
        
        let pitchRate = 1.0;
        switch (effectId) {
            case 'budi': pitchRate = 0.85; break;
            case 'joko': pitchRate = 0.75; break;
            case 'agung': pitchRate = 0.65; break;
            case 'citra': pitchRate = 1.4; break;
            case 'rini': pitchRate = 1.6; break;
        }
    
        source.playbackRate.value = pitchRate;
        source.connect(offlineContext.destination);
        source.start(0);
        const renderedBuffer = await offlineContext.startRendering();
        
        const wavBuffer = bufferToWav(renderedBuffer);
        return new Blob([wavBuffer], { type: 'audio/wav' });
    }, [bufferToWav]);
    
    const handleEnterRoom = async () => {
        setConnectionError(null);
        const identity = `user-${Math.random().toString(36).substring(7).slice(0, 5)}`;
        
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const resp = await fetch(`/api/token?roomName=${roomName}&identity=${identity}`);
            if (!resp.ok) throw new Error('Failed to get token');
            const { token } = await resp.json();
            const newRoom = new Room();
            const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
            if (!wsUrl) throw new Error("LiveKit URL is not configured.");
            
            await newRoom.connect(wsUrl, token);
            setRoom(newRoom);
            setIsInLobby(false);
        } catch (error: any) {
            console.error("Error connecting to LiveKit:", error);
            setConnectionError(error.message || 'An unexpected error occurred.');
        }
    };
    
    const broadcastPacket = useCallback(async (packet: Packet) => {
        if (!room) return;
        try {
            const data = new TextEncoder().encode(JSON.stringify(packet));
            await room.localParticipant.publishData(data, { reliable: true });
        } catch (error) {
            console.error("Failed to broadcast packet:", error);
        }
    }, [room]);
    
    useEffect(() => {
        if (!room) return;
        
        const showNotification = (message: string) => {
            setConnectionNotification(message);
            setTimeout(() => setConnectionNotification(null), 3000);
        }

        const handleParticipantUpdate = () => setParticipants([room.localParticipant, ...room.remoteParticipants.values()]);
        const handleParticipantConnected = (p: Participant) => { showNotification(`${p.identity} joined.`); handleParticipantUpdate(); };
        const handleParticipantDisconnected = (p: Participant) => { 
            showNotification(`${p.identity} left.`); 
            handleParticipantUpdate();
            setRecordingParticipants(prev => { const newState = {...prev}; delete newState[p.identity]; return newState; });
        };

        const handleDataReceived = async (payload: Uint8Array, participant?: Participant) => {
            if (!participant) return;
            try {
                const packet = JSON.parse(new TextDecoder().decode(payload)) as Packet;
                
                if (packet.type === 'voice-chunk') {
                    if (!receivedChunksRef.current[packet.noteId]) {
                        receivedChunksRef.current[packet.noteId] = new Array(packet.total);
                    }
                    receivedChunksRef.current[packet.noteId][packet.index] = packet.chunk;

                     if (receivedChunksRef.current[packet.noteId].every(c => c)) {
                        const fullBase64 = receivedChunksRef.current[packet.noteId].join('');
                        const audioBuffer = base64ToArrayBuffer(fullBase64);
                        const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
                        const audioUrl = URL.createObjectURL(audioBlob);
                        
                        const newNote: VoiceNote = {
                            id: packet.noteId,
                            sender: { id: participant.sid, name: participant.identity },
                            audioUrl, timestamp: Date.now(), isPlaying: false,
                            status: 'delivered', effectId: packet.effectId, // Not used by receiver but good for consistency
                        };
                        setVoiceNotes(prev => [newNote, ...prev]);
                        delete receivedChunksRef.current[packet.noteId];
                        broadcastPacket({ type: 'status-update', noteId: newNote.id, status: 'delivered' });
                    }
                } else if (packet.type === 'status') {
                    setRecordingParticipants(prev => ({...prev, [participant.identity]: packet.status === 'recording'}));
                } else if (packet.type === 'delete-note') {
                    setVoiceNotes(prev => prev.filter(note => note.id !== packet.noteId));
                } else if (packet.type === 'status-update') {
                     setVoiceNotes(prev => prev.map(note => 
                        note.id === packet.noteId ? {...note, status: packet.status} : note
                    ));
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
    }, [room, broadcastPacket]);
    
    const handleStartRecording = useCallback(async () => {
        setRecordingStatus('recording');
        broadcastPacket({ type: 'status', status: 'recording' });
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            audioChunksRef.current = [];
            mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
            mediaRecorderRef.current.onstop = () => {
                broadcastPacket({ type: 'status', status: 'idle' });
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const audioUrl = URL.createObjectURL(audioBlob);
                setLastRecording({ blob: audioBlob, url: audioUrl });
                setRecordingStatus('reviewing');
                stream.getTracks().forEach(track => track.stop());
            };
            mediaRecorderRef.current.start();
        } catch (error) {
            setRecordingStatus('idle');
            broadcastPacket({ type: 'status', status: 'idle' });
        }
    }, [broadcastPacket]);

    const handleStopRecording = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
    }, []);
    
    const handleSendNote = useCallback(async () => {
        if (!lastRecording.blob || !room) return;
        setRecordingStatus('processing');
        try {
            const processedBlob = await applyVoiceEffect(lastRecording.blob, selectedVoice);
            const rawAudioBuffer = await processedBlob.arrayBuffer();

            setRecordingStatus('sending');
            const base64Audio = arrayBufferToBase64(rawAudioBuffer);
            const noteId = `vn-${Date.now()}-${room.localParticipant.identity}`;
            const totalChunks = Math.ceil(base64Audio.length / CHUNK_SIZE);
            
            for (let i = 0; i < totalChunks; i++) {
                const chunk = base64Audio.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                await broadcastPacket({type: 'voice-chunk', noteId, chunk, index: i, total: totalChunks, effectId: selectedVoice});
            }
            
            const audioUrl = URL.createObjectURL(processedBlob);
            const newNote: VoiceNote = {
                id: noteId, sender: { id: room.localParticipant.sid, name: 'You' },
                audioUrl, timestamp: Date.now(), isPlaying: false, status: 'sent', effectId: selectedVoice,
            };
            setVoiceNotes(prev => [newNote, ...prev]);

        } catch (error) {
            console.error("Error sending voice note:", error);
        } finally {
            setRecordingStatus('idle');
            if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
            setLastRecording({ blob: null, url: null });
        }
    }, [lastRecording.blob, room, selectedVoice, broadcastPacket, applyVoiceEffect]);

    const handleDiscardNote = useCallback(() => {
        if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
        setLastRecording({ blob: null, url: null });
        setRecordingStatus('idle');
        broadcastPacket({ type: 'status', status: 'idle' });
    }, [broadcastPacket]);

    const handlePlayPause = useCallback((noteId: string) => {
        const noteToPlay = voiceNotes.find(n => n.id === noteId);
        if (!noteToPlay) return;

        if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
            audioPlayerRef.current.pause();
            if (audioPlayerRef.current.dataset.noteId === noteId) return;
        }
        
        const newAudio = new Audio(noteToPlay.audioUrl);
        audioPlayerRef.current = newAudio;
        audioPlayerRef.current.dataset.noteId = noteId;

        newAudio.onplay = () => {
             setVoiceNotes(prev => prev.map(n => n.id === noteId ? {...n, isPlaying: true} : {...n, isPlaying: false}));
             if(noteToPlay.sender.name !== 'You' && noteToPlay.status !== 'played') {
                broadcastPacket({ type: 'status-update', noteId, status: 'played' });
             }
        };
        newAudio.onpause = newAudio.onended = () => {
             setVoiceNotes(prev => prev.map(n => n.id === noteId ? {...n, isPlaying: false} : n));
        };
        newAudio.play();
    }, [voiceNotes, broadcastPacket]);
    
    const handleDeleteNote = useCallback((noteId: string) => {
        setVoiceNotes(prev => prev.filter(n => n.id !== noteId));
        broadcastPacket({type: 'delete-note', noteId});
    }, [broadcastPacket]);

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
                    onDeleteNote={handleDeleteNote}
                    localParticipant={room?.localParticipant}
                    recordingParticipants={recordingParticipants}
                />
            )}
        </div>
    );
}

// --- UI Components ---
const Lobby = React.memo(({ onEnterRoom, connectionError, roomName, isConnecting, selectedVoice, setSelectedVoice }: any) => {
  const handleShare = () => {
      const text = `Join my anonymous voice chat room on Veil!\n\nRoom Name: ${roomName}\nLink: ${window.location.href}`;
      navigator.clipboard.writeText(text);
      alert('Room link and name copied to clipboard!');
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-[#111] p-8 rounded-2xl flex flex-col border border-[#222]">
          <h2 className="text-2xl font-bold mb-2 text-center">Voice Notes Room</h2>
          <div className="flex justify-center items-center gap-2 mb-8">
            <p className="text-center text-gray-400">Room: <span className="font-bold text-white">{roomName}</span></p>
            <button onClick={handleShare} className="p-2 rounded-full hover:bg-gray-700 transition-colors"><ShareIcon className="w-5 h-5"/></button>
          </div>
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
});

const InCall = React.memo(({ roomName, participants, voiceNotes, recordingStatus, onStartRecording, onStopRecording, onSendNote, onDiscardNote, lastRecordingUrl, onPlayPause, onDeleteNote, localParticipant, recordingParticipants }: any) => {
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
                            {p.sid !== localParticipant?.sid && recordingParticipants[p.identity] && <span className="ml-2 text-red-500 font-bold animate-pulse">REC</span>}
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
                                <p className="font-bold text-white">{note.sender.name}</p>
                                <div className="flex items-center gap-2 text-xs text-gray-400">
                                    <span>{new Date(note.timestamp).toLocaleTimeString()}</span>
                                    {note.sender.name === 'You' && <ReadReceipt status={note.status} />}
                                </div>
                            </div>
                            {note.sender.name === 'You' && (
                                <button onClick={() => onDeleteNote(note.id)} className="p-2 text-gray-500 hover:text-red-500 transition-colors"><TrashIcon className="w-5 h-5"/></button>
                            )}
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
                {recordingStatus === 'processing' && ( <div className="text-gray-400">Processing...</div> )}
                {recordingStatus === 'sending' && ( <div className="text-gray-400">Sending...</div> )}
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
});

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

const ReadReceipt = ({ status }: { status: NoteStatus }) => {
    if (status === 'played') {
        return <CheckDoubleIcon className="w-4 h-4 text-blue-400" />;
    }
    if (status === 'delivered') {
        return <CheckDoubleIcon className="w-4 h-4 text-gray-500" />;
    }
    return <CheckIcon className="w-4 h-4 text-gray-500" />;
}

// --- SVG Icons ---
const MicIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path> </svg> );
const PlayIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M8 5v14l11-7z"></path> </svg> );
const PauseIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path> </svg> );
const StopIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M6 6h12v12H6z"></path> </svg> );
const SendIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path> </svg> );
const XIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path> </svg> );
const MessageSquareIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path> </svg> );
const UsersIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M18 18v-5.25m0 0a3 3 0 00-3-3m3 3a3 3 0 00-3-3m-3 3a3 3 0 00-3-3m3 3a3 3 0 00-3-3m-3 3a3 3 0 00-3-3m3 3a3 3 0 00-3-3m0 9.75V18m0-9.75a3 3 0 013-3m-3 3a3 3 0 00-3 3m3-3a3 3 0 013-3m-3 3a3 3 0 00-3 3m6.75 3.375c.621 1.278 1.694 2.34 2.873 3.118a48.455 48.455 0 01-5.746 0c1.179-.778 2.252-1.84 2.873-3.118z"></path></svg>);
const ShareIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"></path></svg>);
const TrashIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg>);
const CheckIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"></path></svg>);
const CheckDoubleIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}><path d="M0.41 13.41L6 19l1.41-1.42L1.83 12 0.41 13.41zM22.41 5.41L12 15.83l-1.41-1.42L21 4 22.41 5.41zM18 7l-1.41-1.42L6 16.17 7.41 17.58 18 7z"></path></svg>);

