"use client";

import React, { useEffect, useState, SVGProps, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
    Room,
    RoomEvent,
    Participant,
    ConnectionState,
} from 'livekit-client';
import { AnimatePresence, motion } from 'framer-motion';

// --- Constants ---
const CHUNK_SIZE = 30 * 1024; // 30 KB - smaller chunks for better reliability
const MAX_RECORDING_TIME = 60 * 1000; // 60 seconds
const AUDIO_CONSTRAINTS = {
    audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 44100,
        channelCount: 1
    }
};

// --- Voice Options Data ---
const voiceOptions = [
    { id: 'budi', name: 'Budi', description: 'Deep voice' },
    { id: 'joko', name: 'Joko', description: 'Lower tone' },
    { id: 'agung', name: 'Agung', description: 'Bass voice' },
    { id: 'citra', name: 'Citra', description: 'Higher pitch' },
    { id: 'rini', name: 'Rini', description: 'Bright voice' },
];

// --- Enhanced Types ---
type NoteStatus = 'sent' | 'delivered' | 'played' | 'failed';
type RecordingStatus = 'idle' | 'recording' | 'reviewing' | 'sending' | 'processing';
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

interface SendProgress {
    noteId: string;
    sent: number;
    total: number;
    percentage: number;
}

interface VoiceNote {
    id: string;
    sender: { id: string; name: string };
    audioUrl: string;
    timestamp: number;
    isPlaying: boolean;
    status: NoteStatus;
    duration?: number;
    waveform?: number[];
}

// --- Packet type for data channel communication ---
type Packet =
    | { type: 'voice-chunk'; noteId: string; chunk: string; index: number; total: number }
    | { type: 'voice-end'; noteId: string; totalChunks: number; effectId: string; duration: number }
    | { type: 'status'; status: 'recording' | 'idle' }
    | { type: 'delete-note'; noteId: string }
    | { type: 'status-update'; noteId: string; status: NoteStatus }
    | { type: 'typing-indicator'; isTyping: boolean }
    | { type: 'request-chunks'; noteId: string; missingIndices: number[] }
    | { type: 'chunk-resend'; noteId: string; chunk: string; index: number }
    | { type: 'chunk-ack'; noteId: string; index: number; from: string };

// --- Enhanced Audio Utilities ---
class AudioProcessor {
    private static audioContext: AudioContext | null = null;

    static getAudioContext(): AudioContext {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        return this.audioContext;
    }

    static async applyVoiceEffect(audioBlob: Blob, effectId: string): Promise<Blob> {
        try {
            const audioContext = this.getAudioContext();
            const arrayBuffer = await audioBlob.arrayBuffer();
            const sourceAudioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0)); // Create a copy

            if (!sourceAudioBuffer || sourceAudioBuffer.length === 0) {
                console.error('Invalid audio buffer');
                return audioBlob;
            }

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
                default: pitchRate = 1.0;
            }
            source.playbackRate.value = pitchRate;

            const compressor = offlineContext.createDynamicsCompressor();
            compressor.threshold.value = -24;
            compressor.knee.value = 30;
            compressor.ratio.value = 12;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.25;

            source.connect(compressor);
            compressor.connect(offlineContext.destination);
            source.start(0);

            const renderedBuffer = await offlineContext.startRendering();

            if (!renderedBuffer || renderedBuffer.length === 0) {
                console.error('Rendering failed');
                return audioBlob;
            }

            const wavBuffer = this.bufferToWav(renderedBuffer);
            return new Blob([wavBuffer], { type: 'audio/wav' });
        } catch (error) {
            console.error('Voice effect processing failed:', error);
            return audioBlob;
        }
    }

    static bufferToWav(abuffer: AudioBuffer): ArrayBuffer {
        const numOfChan = abuffer.numberOfChannels;
        const length = abuffer.length * numOfChan * 2 + 44;
        const buffer = new ArrayBuffer(length);
        const view = new DataView(buffer);
        const channels: Float32Array[] = [];
        let i: number, sample: number, offset = 0, pos = 0;

        const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };
        const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };

        // WAV header
        setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
        setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan);
        setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan);
        setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164);
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
    }

    static async getAudioDuration(audioBlob: Blob): Promise<number> {
        return new Promise((resolve) => {
            const audio = new Audio();
            audio.onloadedmetadata = () => resolve(audio.duration);
            audio.onerror = () => resolve(0);
            audio.src = URL.createObjectURL(audioBlob);
        });
    }

    static generateWaveform(audioBuffer: AudioBuffer, samples = 40): number[] {
        const rawData = audioBuffer.getChannelData(0);
        const blockSize = Math.floor(rawData.length / samples);
        const filteredData = [];

        for (let i = 0; i < samples; i++) {
            let blockStart = blockSize * i;
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                sum += Math.abs(rawData[blockStart + j]);
            }
            filteredData.push(sum / blockSize);
        }

        const multiplier = Math.pow(Math.max(...filteredData), -1);
        return filteredData.map(n => n * multiplier);
    }
}

// --- Enhanced Base64 Helpers ---
const EncodingUtils = {
    arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000; // 32KB chunks to avoid call stack size exceeded

        for (let i = 0; i < bytes.length; i += chunkSize) {
            const chunk = bytes.subarray(i, i + chunkSize);
            binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        return window.btoa(binary);
    },

    base64ToArrayBuffer(base64: string): ArrayBuffer {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }
};

// --- Custom Hooks ---
const useNotifications = () => {
    const [notification, setNotification] = useState<string | null>(null);

    const showNotification = useCallback((message: string, duration = 3000) => {
        setNotification(message);
        setTimeout(() => setNotification(null), duration);
    }, []);

    return { notification, showNotification };
};

const useAudioRecorder = () => {
    const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
    const [recordingTime, setRecordingTime] = useState(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const startRecording = useCallback(async (): Promise<boolean> => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
            streamRef.current = stream;

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm';

            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType });
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorderRef.current.onstop = () => {
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
            };

            mediaRecorderRef.current.start();
            setRecordingStatus('recording');
            setRecordingTime(0);

            const startTime = Date.now();
            const timer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                setRecordingTime(elapsed);

                if (elapsed >= MAX_RECORDING_TIME / 1000) {
                    stopRecording();
                }
            }, 100);
            recordingTimerRef.current = timer;


            return true;
        } catch (error) {
            console.error('Failed to start recording:', error);
            setRecordingStatus('idle');
            return false;
        }
    }, []);

    const stopRecording = useCallback((): Promise<Blob | null> => {
        return new Promise((resolve) => {
            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
                recordingTimerRef.current = null;
            }

            if (mediaRecorderRef.current?.state === 'recording') {
                mediaRecorderRef.current.onstop = () => {
                    const audioBlob = new Blob(audioChunksRef.current, {
                        type: mediaRecorderRef.current?.mimeType || 'audio/webm'
                    });
                    setRecordingStatus('reviewing');
                    resolve(audioBlob);
                };
                mediaRecorderRef.current.stop();
            } else {
                setRecordingStatus('idle');
                resolve(null);
            }
        });
    }, []);

    const resetRecording = useCallback(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        if (recordingTimerRef.current) {
            clearInterval(recordingTimerRef.current);
            recordingTimerRef.current = null;
        }
        setRecordingStatus('idle');
        setRecordingTime(0);
        audioChunksRef.current = [];
    }, []);

    return {
        recordingStatus,
        setRecordingStatus,
        recordingTime,
        startRecording,
        stopRecording,
        resetRecording
    };
};

// --- Main Component ---
export default function VoiceNotesPage({ params }: { params: { roomName: string } }) {
    const [isInLobby, setIsInLobby] = useState(true);
    const [room, setRoom] = useState<Room | undefined>(undefined);
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
    const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
    const [recordingParticipants, setRecordingParticipants] = useState<Record<string, boolean>>({});
    const [lastRecording, setLastRecording] = useState<{ blob: Blob | null; url: string | null }>({ blob: null, url: null });
    const [selectedVoice, setSelectedVoice] = useState('budi');
    const [isOnline, setIsOnline] = useState(true);
    const [sendProgress, setSendProgress] = useState<SendProgress | null>(null);
    const [copyNotification, setCopyNotification] = useState(false);

    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const receivedChunksRef = useRef<Record<string, string[]>>({});
    const pendingNotesRef = useRef<Record<string, { totalChunks: number; effectId: string; duration: number; participant: Participant }>>({});
    const sentChunksRef = useRef<Record<string, string[]>>({});
    const chunkAcksRef = useRef<Record<string, Set<number>>>({});
    const roomName = params.roomName;

    const { notification, showNotification } = useNotifications();
    const {
        recordingStatus,
        setRecordingStatus,
        recordingTime,
        startRecording,
        stopRecording,
        resetRecording
    } = useAudioRecorder();
    
    const broadcastPacket = useCallback(async (packet: Packet) => {
        if (!room || room.state !== ConnectionState.Connected) {
            console.warn('Cannot broadcast: room not connected');
            return false;
        }
        
        try {
            const data = new TextEncoder().encode(JSON.stringify(packet));
            // Using RELIABLE ensures packet delivery
            await room.localParticipant.publishData(data, { reliable: true });
            return true;
        } catch (error) {
            console.error("Failed to broadcast packet:", error);
            return false;
        }
    }, [room]);

    const processCompleteAudio = useCallback((noteId: string, participant: Participant, duration: number) => {
        const chunks = receivedChunksRef.current[noteId];
        if (!chunks || chunks.some(c => c === null)) {
            console.error(`Cannot process incomplete audio for ${noteId}`);
            return;
        }
        
        try {
            const fullBase64 = chunks.join('');
            const audioBuffer = EncodingUtils.base64ToArrayBuffer(fullBase64);
            const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
            const audioUrl = URL.createObjectURL(audioBlob);
            
            const newNote: VoiceNote = {
                id: noteId,
                sender: { id: participant.sid, name: participant.identity },
                audioUrl,
                timestamp: Date.now(),
                isPlaying: false,
                status: 'delivered',
                duration
            };
            
            setVoiceNotes(prev => [newNote, ...prev]);
            
            // Cleanup refs
            delete receivedChunksRef.current[noteId];
            delete pendingNotesRef.current[noteId];
            
            // Notify sender that the message was delivered
            broadcastPacket({ type: 'status-update', noteId: newNote.id, status: 'delivered' });

        } catch (error) {
            console.error(`Error processing audio ${noteId}:`, error);
            showNotification('Failed to process received voice note');
        }
    }, [broadcastPacket, showNotification]);

    // --- Effect for Network Status ---
    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);
        
        // Set initial state
        setIsOnline(navigator.onLine);

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);
    
    // --- Effect for LiveKit Room Connection and Event Handling ---
    useEffect(() => {
        if (!room) return;
        
        const handleParticipantUpdate = () => {
            setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
        };
        
        const handleParticipantConnected = (participant: Participant) => {
            showNotification(`${participant.identity} joined`);
            handleParticipantUpdate();
        };
        
        const handleParticipantDisconnected = (participant: Participant) => {
            showNotification(`${participant.identity} left`);
            handleParticipantUpdate();
            setRecordingParticipants(prev => {
                const newState = { ...prev };
                delete newState[participant.identity];
                return newState;
            });
        };

        const handleDataReceived = async (payload: Uint8Array, participant?: Participant) => {
            if (!participant) return;
            
            try {
                const packet = JSON.parse(new TextDecoder().decode(payload)) as Packet;
                
                switch (packet.type) {
                    case 'voice-chunk':
                        if (!receivedChunksRef.current[packet.noteId]) {
                            receivedChunksRef.current[packet.noteId] = new Array(packet.total).fill(null);
                        }
                        receivedChunksRef.current[packet.noteId][packet.index] = packet.chunk;
                        
                        const received = receivedChunksRef.current[packet.noteId].filter(c => c !== null).length;
                        
                        const pendingNote = pendingNotesRef.current[packet.noteId];
                        if (pendingNote && received === packet.total) {
                            processCompleteAudio(packet.noteId, pendingNote.participant, pendingNote.duration);
                        }
                        break;
                        
                    case 'voice-end':
                        const chunks = receivedChunksRef.current[packet.noteId];
                        const receivedCount = chunks ? chunks.filter(c => c !== null).length : 0;
                        
                        if (chunks && receivedCount === packet.totalChunks) {
                            processCompleteAudio(packet.noteId, participant, packet.duration);
                        } else {
                             pendingNotesRef.current[packet.noteId] = {
                                totalChunks: packet.totalChunks,
                                effectId: packet.effectId,
                                duration: packet.duration,
                                participant: participant
                            };
                        }
                        break;
                        
                    case 'status':
                        setRecordingParticipants(prev => ({
                            ...prev,
                            [participant.identity]: packet.status === 'recording'
                        }));
                        break;
                        
                    case 'delete-note':
                        setVoiceNotes(prev => prev.filter(note => note.id !== packet.noteId));
                        break;
                        
                    case 'status-update':
                        setVoiceNotes(prev => prev.map(note => 
                            note.id === packet.noteId ? { ...note, status: packet.status } : note
                        ));
                        break;
                }
            } catch (error) {
                console.error('Error processing received data:', error);
            }
        };

        const handleConnectionStateChanged = (state: ConnectionState) => {
            switch (state) {
                case ConnectionState.Connected: setConnectionStatus('connected'); break;
                case ConnectionState.Connecting: setConnectionStatus('connecting'); break;
                case ConnectionState.Disconnected:
                    setConnectionStatus('disconnected');
                    showNotification('Disconnected from room');
                    break;
                case ConnectionState.Failed:
                    setConnectionStatus('failed');
                    showNotification('Connection failed');
                    break;
            }
        };

        handleParticipantUpdate();
        room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
        room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
        room.on(RoomEvent.DataReceived, handleDataReceived);
        room.on(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);

        return () => {
            room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
            room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
            room.off(RoomEvent.DataReceived, handleDataReceived);
            room.off(RoomEvent.ConnectionStateChanged, handleConnectionStateChanged);
        };
    }, [room, processCompleteAudio, showNotification]);


    // --- Effect for Component Unmount Cleanup ---
    useEffect(() => {
        return () => {
            if (room) {
                room.disconnect();
            }
            voiceNotes.forEach(note => {
                if (note.audioUrl) URL.revokeObjectURL(note.audioUrl);
            });
            if (lastRecording.url) {
                URL.revokeObjectURL(lastRecording.url);
            }
            receivedChunksRef.current = {};
            pendingNotesRef.current = {};
            sentChunksRef.current = {};
            chunkAcksRef.current = {};
        };
    }, [room, voiceNotes, lastRecording.url]);


    const handleEnterRoom = async () => {
        if (!isOnline) {
            showNotification('Please check your internet connection');
            return;
        }

        setConnectionStatus('connecting');
        const identity = `user-${Math.random().toString(36).substring(2, 7)}`;
        
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            
            const resp = await fetch(`/api/token?roomName=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(identity)}`);
            
            if (!resp.ok) throw new Error(`Failed to get token: ${resp.statusText}`);
            
            const { token } = await resp.json();
            const newRoom = new Room();
            const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
            
            if (!wsUrl) throw new Error("LiveKit URL is not configured.");
            
            await newRoom.connect(wsUrl, token);
            setRoom(newRoom);
            setConnectionStatus('connected');
            setIsInLobby(false);
            showNotification(`Connected to room ${roomName}`);
        } catch (error: any) {
            console.error("Error connecting to LiveKit:", error);
            setConnectionStatus('failed');
            showNotification(`Connection failed: ${error.message}`, 5000);
        }
    };

    const handleStartRecording = useCallback(async () => {
        const success = await startRecording();
        if (success) {
            broadcastPacket({ type: 'status', status: 'recording' });
        } else {
            showNotification('Failed to start recording. Please check microphone permissions.');
        }
    }, [startRecording, broadcastPacket, showNotification]);

    const handleStopRecording = useCallback(async () => {
        const audioBlob = await stopRecording();
        if (audioBlob) {
            const audioUrl = URL.createObjectURL(audioBlob);
            setLastRecording({ blob: audioBlob, url: audioUrl });
        }
        broadcastPacket({ type: 'status', status: 'idle' });
    }, [stopRecording, broadcastPacket]);

    const handleSendNote = useCallback(async () => {
        if (!lastRecording.blob || !room) return;
        
        setRecordingStatus('processing');
        
        try {
            const processedBlob = await AudioProcessor.applyVoiceEffect(lastRecording.blob, selectedVoice);
            const duration = await AudioProcessor.getAudioDuration(processedBlob);
            const rawAudioBuffer = await processedBlob.arrayBuffer();

            setRecordingStatus('sending');
            const base64Audio = EncodingUtils.arrayBufferToBase64(rawAudioBuffer);
            const noteId = `vn-${Date.now()}-${room.localParticipant.identity}`;
            const totalChunks = Math.ceil(base64Audio.length / CHUNK_SIZE);

            setSendProgress({ noteId, sent: 0, total: totalChunks, percentage: 0 });
            
            let sentCount = 0;
            for (let i = 0; i < totalChunks; i++) {
                const chunk = base64Audio.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                const success = await broadcastPacket({
                    type: 'voice-chunk',
                    noteId,
                    chunk,
                    index: i,
                    total: totalChunks
                });
                
                if (success) {
                    sentCount++;
                    setSendProgress(p => p ? {...p, sent: sentCount, percentage: Math.round((sentCount / totalChunks) * 100)} : null);
                }
                // Small delay to avoid network congestion
                if (i < totalChunks - 1) await new Promise(r => setTimeout(r, 10));
            }
            
            const endSuccess = await broadcastPacket({
                type: 'voice-end',
                noteId,
                totalChunks,
                effectId: selectedVoice,
                duration
            });

            if (!endSuccess || sentCount < totalChunks) {
                 throw new Error(`Failed to send all data. Sent ${sentCount}/${totalChunks} chunks.`);
            }
            
            const newNote: VoiceNote = {
                id: noteId,
                sender: { id: room.localParticipant.sid, name: 'You' },
                audioUrl: URL.createObjectURL(processedBlob),
                timestamp: Date.now(),
                isPlaying: false,
                status: 'sent',
                duration
            };
            
            setVoiceNotes(prev => [newNote, ...prev]);
            showNotification('Voice note sent!');

        } catch (error) {
            console.error("Error sending voice note:", error);
            showNotification('Failed to send voice note. Please try again.');
            setVoiceNotes(prev => prev.map(note => 
                note.sender.name === 'You' && note.status === 'sent' 
                    ? { ...note, status: 'failed' }
                    : note
            ));
        } finally {
            setRecordingStatus('idle');
            setSendProgress(null);
            if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
            setLastRecording({ blob: null, url: null });
        }
    }, [lastRecording.blob, room, selectedVoice, broadcastPacket, showNotification, setRecordingStatus]);

    const handleDiscardNote = useCallback(() => {
        if (lastRecording.url) {
            URL.revokeObjectURL(lastRecording.url);
        }
        setLastRecording({ blob: null, url: null });
        resetRecording();
        broadcastPacket({ type: 'status', status: 'idle' });
    }, [lastRecording.url, resetRecording, broadcastPacket]);

    const handlePlayPause = useCallback((noteId: string) => {
        const noteToPlay = voiceNotes.find(n => n.id === noteId);
        if (!noteToPlay) return;

        if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
            const currentlyPlayingId = audioPlayerRef.current.dataset.noteId;
            audioPlayerRef.current.pause();
            setVoiceNotes(prev => prev.map(n => n.id === currentlyPlayingId ? { ...n, isPlaying: false } : n));
            if (currentlyPlayingId === noteId) {
                return; 
            }
        }
        
        const newAudio = new Audio(noteToPlay.audioUrl);
        audioPlayerRef.current = newAudio;
        audioPlayerRef.current.dataset.noteId = noteId;

        newAudio.onplay = () => {
            setVoiceNotes(prev => prev.map(n => n.id === noteId ? { ...n, isPlaying: true } : { ...n, isPlaying: false }));
            if (noteToPlay.sender.name !== 'You' && noteToPlay.status !== 'played') {
                broadcastPacket({ type: 'status-update', noteId, status: 'played' });
                 setVoiceNotes(prev => prev.map(n => n.id === noteId ? { ...n, status: 'played' } : n));
            }
        };
        
        newAudio.onpause = newAudio.onended = () => {
            setVoiceNotes(prev => prev.map(n => n.id === noteId ? { ...n, isPlaying: false } : n));
        };
        
        newAudio.onerror = () => {
            console.error('Error playing audio');
            showNotification('Error playing voice note');
        };
        
        newAudio.play().catch(e => {
            console.error("Error playing audio:", e);
            showNotification('Could not play audio.');
        });
    }, [voiceNotes, broadcastPacket, showNotification]);
    
    const handleDeleteNote = useCallback((noteId: string) => {
        const noteToDelete = voiceNotes.find(n => n.id === noteId);
        if (noteToDelete?.audioUrl) {
            URL.revokeObjectURL(noteToDelete.audioUrl);
        }
        setVoiceNotes(prev => prev.filter(n => n.id !== noteId));
        broadcastPacket({ type: 'delete-note', noteId });
    }, [voiceNotes, broadcastPacket]);


    return (
        <div className="bg-[#080808] text-white min-h-screen flex flex-col font-sans">
            <ConnectionNotification message={notification} />
            {!isOnline && (
                <div className="bg-red-600 text-white p-2 text-center text-sm sticky top-0 z-50">
                    <WifiOffIcon className="w-4 h-4 inline mr-2" />
                    You're offline. Please check your internet connection.
                </div>
            )}
            {isInLobby ? (
                <Lobby 
                    onEnterRoom={handleEnterRoom} 
                    connectionStatus={connectionStatus}
                    roomName={roomName}
                    selectedVoice={selectedVoice}
                    setSelectedVoice={setSelectedVoice}
                    isOnline={isOnline}
                    copyNotification={copyNotification}
                    setCopyNotification={setCopyNotification}
                />
            ) : (
                <InCall
                    roomName={roomName}
                    participants={participants}
                    voiceNotes={voiceNotes}
                    recordingStatus={recordingStatus}
                    recordingTime={recordingTime}
                    onStartRecording={handleStartRecording}
                    onStopRecording={handleStopRecording}
                    onSendNote={handleSendNote}
                    onDiscardNote={handleDiscardNote}
                    lastRecordingUrl={lastRecording.url}
                    onPlayPause={handlePlayPause}
                    onDeleteNote={handleDeleteNote}
                    localParticipant={room?.localParticipant}
                    recordingParticipants={recordingParticipants}
                    connectionStatus={connectionStatus}
                    sendProgress={sendProgress}
                    copyNotification={copyNotification}
                    setCopyNotification={setCopyNotification}
                />
            )}
        </div>
    );
}

// --- UI Components ---
const Lobby = React.memo(({ 
    onEnterRoom, 
    connectionStatus, 
    roomName, 
    selectedVoice, 
    setSelectedVoice,
    isOnline,
    copyNotification,
    setCopyNotification 
}: any) => {
    const handleShare = () => {
        navigator.clipboard.writeText(window.location.href).then(() => {
            setCopyNotification(true);
            setTimeout(() => setCopyNotification(false), 2000);
        });
    };

    return (
        <div className="flex-1 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                <div className="bg-[#111] p-8 rounded-2xl flex flex-col border border-[#222]">
                    <div className="text-center mb-6">
                        <h2 className="text-2xl font-bold mb-2">Voice Notes Room</h2>
                         <div className="flex justify-center items-center gap-2 mb-2">
                            <p className="text-gray-400">Room Code:</p>
                            <div className="flex items-center gap-2 bg-[#222] px-3 py-1 rounded-lg">
                                <span className="font-mono font-bold text-white text-lg">{roomName}</span>
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 mb-4">
                            Choose a voice and join the room.
                        </p>
                        <ConnectionStatusIndicator status={connectionStatus} />
                    </div>
                    
                    <div className="mb-8 flex-grow">
                        <h3 className="text-lg font-semibold mb-3 text-center">Choose Your Anonymous Voice</h3>
                        <VoiceOptions selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
                    </div>

                     <button 
                        onClick={handleShare} 
                        className="w-full font-bold py-3 mb-4 rounded-xl text-lg bg-[#222] hover:bg-[#333] flex items-center justify-center gap-2 transition-all"
                    >
                        {copyNotification ? <><CheckIcon className="w-5 h-5 text-green-400"/> Copied!</> : <><ShareIcon className="w-5 h-5"/> Share Invite</>}
                    </button>
                    
                    <button 
                        onClick={onEnterRoom} 
                        disabled={connectionStatus === 'connecting' || !isOnline} 
                        className="btn-primary w-full font-bold py-4 rounded-xl text-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                        {connectionStatus === 'connecting' ? (
                            <div className="flex items-center justify-center gap-2">
                                <LoadingSpinner />
                                Connecting...
                            </div>
                        ) : !isOnline ? (
                            'Offline - Check Connection'
                        ) : (
                            'Join Room'
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
});

const InCall = React.memo(({ 
    roomName, 
    participants, 
    voiceNotes, 
    recordingStatus, 
    recordingTime,
    onStartRecording, 
    onStopRecording, 
    onSendNote, 
    onDiscardNote, 
    lastRecordingUrl, 
    onPlayPause, 
    onDeleteNote, 
    localParticipant, 
    recordingParticipants,
    connectionStatus,
    sendProgress,
    copyNotification,
    setCopyNotification 
}: any) => {
    const reviewPlayerRef = useRef<HTMLAudioElement>(null);
    const hasPeers = participants.length > 1;

    const playReview = () => {
        if (reviewPlayerRef.current) {
            reviewPlayerRef.current.play();
        }
    };

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const formatDuration = (duration?: number) => {
        if (duration === undefined) return '';
        const mins = Math.floor(duration / 60);
        const secs = Math.floor(duration % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };

    const handleCopyRoomCode = () => {
        navigator.clipboard.writeText(window.location.href).then(() => {
            setCopyNotification(true);
            setTimeout(() => setCopyNotification(false), 2000);
        });
    };

    return (
        <div className="flex-1 flex flex-col p-4 md:p-6 max-w-4xl mx-auto w-full">
            <header className="mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-3xl font-bold text-white">Voice Notes</h1>
                    <ConnectionStatusIndicator status={connectionStatus} />
                </div>
                 <div className="flex items-center gap-4 mt-2">
                    <p className="text-gray-400">
                        You are <span className="font-mono bg-[#222] px-2 py-1 rounded">{localParticipant?.identity}</span>
                    </p>
                    <button 
                        onClick={handleCopyRoomCode} 
                        className="flex items-center gap-2 bg-[#222] px-3 py-1 rounded-lg hover:bg-[#333] transition-colors"
                        title="Copy invite link"
                    >
                        <span className="font-mono font-bold text-white">{roomName}</span>
                        {copyNotification ? (
                            <CheckIcon className="w-4 h-4 text-green-400"/>
                        ) : (
                            <CopyIcon className="w-4 h-4 text-gray-400"/>
                        )}
                    </button>
                </div>
                <div className="text-gray-400 text-sm mt-2">
                    <span className="font-bold">Participants ({participants.length}):</span>
                    <div className="flex flex-wrap gap-2 mt-1">
                        {participants.map((p: Participant) => (
                            <span key={p.sid} className="bg-[#222] px-2 py-1 rounded-full text-xs flex items-center gap-1">
                                {p.identity}
                                {p.sid !== localParticipant?.sid && recordingParticipants[p.identity] && (
                                    <span className="text-red-500 font-bold animate-pulse">●</span>
                                )}
                            </span>
                        ))}
                    </div>
                </div>
            </header>
            
            <div className="flex-1 bg-[#111] rounded-2xl p-4 overflow-y-auto mb-6 border border-[#222] min-h-[300px]">
                <AnimatePresence>
                    {!hasPeers && voiceNotes.length === 0 && (
                        <motion.div 
                            initial={{ opacity: 0 }} 
                            animate={{ opacity: 1 }} 
                            className="flex flex-col items-center justify-center h-full text-gray-500 text-center"
                        >
                            <UsersIcon className="w-16 h-16 mb-4" />
                            <p className="font-bold text-lg">Waiting for others to join...</p>
                            <p className="text-sm mt-2">Share the room link to invite people.</p>
                        </motion.div>
                    )}
                    {hasPeers && voiceNotes.length === 0 && (
                        <motion.div 
                            initial={{ opacity: 0 }} 
                            animate={{ opacity: 1 }} 
                            className="flex flex-col items-center justify-center h-full text-gray-500 text-center"
                        >
                            <MessageSquareIcon className="w-16 h-16 mb-4" />
                            <p className="font-bold text-lg">No voice notes yet</p>
                            <p className="text-sm mt-2">Tap the mic button to record and send a message.</p>
                        </motion.div>
                    )}
                    {voiceNotes.map((note: VoiceNote) => (
                        <VoiceNoteItem
                            key={note.id}
                            note={note}
                            onPlayPause={onPlayPause}
                            onDelete={onDeleteNote}
                            formatDuration={formatDuration}
                        />
                    ))}
                </AnimatePresence>
            </div>
            
            <RecordingControls
                recordingStatus={recordingStatus}
                recordingTime={recordingTime}
                onStartRecording={onStartRecording}
                onStopRecording={onStopRecording}
                onSendNote={onSendNote}
                onDiscardNote={onDiscardNote}
                lastRecordingUrl={lastRecordingUrl}
                playReview={playReview}
                formatTime={formatTime}
                reviewPlayerRef={reviewPlayerRef}
                sendProgress={sendProgress}
            />
        </div>
    );
});

const VoiceNoteItem = React.memo(({ note, onPlayPause, onDelete, formatDuration }: any) => (
    <motion.div 
        key={note.id}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20, transition: { duration: 0.2 } }}
        layout
        className={`flex items-center space-x-4 p-4 mb-3 rounded-lg transition-colors ${note.sender.name === 'You' ? 'bg-[#1a2c3a]' : 'bg-[#222]'} hover:bg-[#333]`}
    >
        <button 
            onClick={() => onPlayPause(note.id)} 
            className={`p-3 rounded-full transition-all ${
                note.isPlaying 
                    ? 'bg-yellow-500 hover:bg-yellow-400' 
                    : 'bg-blue-600 hover:bg-blue-500'
            }`}
        >
            {note.isPlaying ? (
                <PauseIcon className="w-5 h-5 text-white" />
            ) : (
                <PlayIcon className="w-5 h-5 text-white" />
            )}
        </button>
        
        <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
                <p className="font-bold text-white truncate">{note.sender.name}</p>
                {note.duration !== undefined && (
                    <span className="text-xs text-gray-400 bg-[#444] px-2 py-1 rounded">
                        {formatDuration(note.duration)}
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400">
                <span>{new Date(note.timestamp).toLocaleTimeString()}</span>
                {note.sender.name === 'You' && <ReadReceipt status={note.status} />}
            </div>
        </div>
        
        {note.sender.name === 'You' && (
            <button 
                onClick={() => onDelete(note.id)} 
                className="p-2 text-gray-500 hover:text-red-500 transition-colors"
                title="Delete note"
            >
                <TrashIcon className="w-5 h-5"/>
            </button>
        )}
    </motion.div>
));

const RecordingControls = React.memo(({
    recordingStatus,
    recordingTime,
    onStartRecording,
    onStopRecording,
    onSendNote,
    onDiscardNote,
    lastRecordingUrl,
    playReview,
    formatTime,
    reviewPlayerRef,
    sendProgress
}: any) => (
    <footer className="flex justify-center items-center p-4 h-32">
        {recordingStatus === 'idle' && (
            <div className="text-center">
                <button 
                    onClick={onStartRecording} 
                    className="record-btn idle w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 ease-in-out hover:scale-105"
                >
                    <MicIcon className="w-8 h-8 text-white" />
                </button>
                <p className="text-xs text-gray-400 mt-2">Tap to record</p>
            </div>
        )}
        
        {recordingStatus === 'recording' && (
            <div className="text-center">
                <button 
                    onClick={onStopRecording} 
                    className="record-btn recording w-20 h-20 rounded-full flex items-center justify-center transition-all"
                >
                    <StopIcon className="w-8 h-8 text-white" />
                </button>
                <div className="mt-2 text-sm text-red-400 font-mono">
                    {formatTime(recordingTime)}
                </div>
                <p className="text-xs text-gray-400">Recording... Tap to stop</p>
            </div>
        )}
        
        {recordingStatus === 'reviewing' && (
            <div className="flex items-center gap-4">
                <button 
                    onClick={onDiscardNote} 
                    className="bg-gray-600 hover:bg-gray-500 p-4 rounded-full transition-colors"
                    title="Discard recording"
                >
                    <XIcon className="w-6 h-6 text-white"/>
                </button>
                
                {lastRecordingUrl && (
                    <audio ref={reviewPlayerRef} src={lastRecordingUrl} preload="auto" />
                )}
                
                <button 
                    onClick={playReview} 
                    className="bg-blue-600 hover:bg-blue-500 p-5 rounded-full transition-colors"
                    title="Preview recording"
                >
                    <PlayIcon className="w-8 h-8 text-white"/>
                </button>
                
                <button 
                    onClick={onSendNote} 
                    className="bg-green-600 hover:bg-green-500 p-4 rounded-full transition-colors"
                    title="Send recording"
                >
                    <SendIcon className="w-6 h-6 text-white"/>
                </button>
            </div>
        )}
        
        {(recordingStatus === 'processing' || recordingStatus === 'sending') && (
            <div className="text-center w-48">
                <LoadingSpinner size="large" />
                 <p className="text-gray-400 mt-2">
                    {recordingStatus === 'processing' ? 'Processing...' : 'Sending...'}
                 </p>
                {sendProgress && recordingStatus === 'sending' && (
                    <div className="mt-2">
                        <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div 
                                className="h-full bg-blue-500 transition-all duration-300"
                                style={{ width: `${sendProgress.percentage}%` }}
                            />
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                            {sendProgress.sent}/{sendProgress.total}
                        </p>
                    </div>
                )}
            </div>
        )}
        
        <style jsx>{`
            .record-btn.idle { 
                background: linear-gradient(135deg, #1e40af, #3b82f6);
                box-shadow: 0 4px 20px rgba(59, 130, 246, 0.3);
            }
            .record-btn.recording {
                background: linear-gradient(135deg, #dc2626, #ef4444);
                animation: pulse-red 2s infinite;
            }
            @keyframes pulse-red {
                0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7); }
                70% { box-shadow: 0 0 0 20px rgba(220, 38, 38, 0); }
                100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); }
            }
        `}</style>
    </footer>
));

const ConnectionNotification = ({ message }: { message: string | null }) => (
    <AnimatePresence>
        {message && (
            <motion.div
                initial={{ y: -100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -100, opacity: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="fixed top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg z-50 max-w-sm text-center"
            >
                {message}
            </motion.div>
        )}
    </AnimatePresence>
);

const ConnectionStatusIndicator = ({ status }: { status: ConnectionStatus }) => {
    const statusInfo = {
        connected: { text: 'Connected', color: 'text-green-500', bg: 'bg-green-500' },
        connecting: { text: 'Connecting...', color: 'text-yellow-500', bg: 'bg-yellow-500 animate-pulse' },
        failed: { text: 'Connection Failed', color: 'text-red-500', bg: 'bg-red-500' },
        disconnected: { text: 'Disconnected', color: 'text-gray-500', bg: 'bg-gray-500' },
    }[status];

    return (
        <div className={`flex items-center gap-2 text-sm ${statusInfo.color}`}>
            <div className={`w-2 h-2 rounded-full ${statusInfo.bg}`} />
            {statusInfo.text}
        </div>
    );
};

const VoiceOptions = React.memo(function VoiceOptions({ selectedVoice, setSelectedVoice }: any) {
    return (
        <div className="space-y-2">
            {voiceOptions.map((option) => (
                <div
                    key={option.id}
                    onClick={() => setSelectedVoice(option.id)}
                    className={`voice-option cursor-pointer p-3 rounded-lg border-l-4 flex items-center justify-between transition-all ${
                        selectedVoice === option.id 
                            ? 'selected bg-[#2a2a2a] border-blue-500 shadow-lg' 
                            : 'border-transparent hover:bg-[#1a1a1a] hover:border-gray-600'
                    }`}
                >
                    <div>
                        <span className="font-medium">{option.name}</span>
                        <p className="text-xs text-gray-400">{option.description}</p>
                    </div>
                    <MicIcon className="w-5 h-5 text-gray-400" />
                </div>
            ))}
        </div>
    );
});

const ReadReceipt = ({ status }: { status: NoteStatus }) => {
    const receiptInfo = {
        played: { text: 'Played', icon: CheckDoubleIcon, color: 'text-blue-400' },
        delivered: { text: 'Delivered', icon: CheckDoubleIcon, color: 'text-gray-500' },
        failed: { text: 'Failed', icon: XIcon, color: 'text-red-500' },
        sent: { text: 'Sent', icon: CheckIcon, color: 'text-gray-500' },
    }[status];

    const Icon = receiptInfo.icon;
    return (
        <div className={`flex items-center gap-1 ${receiptInfo.color}`} title={receiptInfo.text}>
            <Icon className="w-4 h-4" />
            <span>{receiptInfo.text}</span>
        </div>
    );
};

const LoadingSpinner = ({ size = 'medium' }: { size?: 'small' | 'medium' | 'large' }) => {
    const sizeClass = {
        small: 'w-4 h-4',
        medium: 'w-6 h-6', 
        large: 'w-8 h-8'
    }[size];

    return (
        <div className={`${sizeClass} border-2 border-gray-600 border-t-white rounded-full animate-spin`} />
    );
};

// --- SVG Icons ---
// (Keeping SVGs as they are, they seem correct and well-defined)
const MicIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path>
    </svg>
);
const PlayIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M8 5v14l11-7z"></path>
    </svg>
);
const PauseIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path>
    </svg>
);
const StopIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M6 6h12v12H6z"></path>
    </svg>
);
const SendIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>
    </svg>
);
const XIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path>
    </svg>
);
const MessageSquareIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path>
    </svg>
);
const UsersIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"></path>
    </svg>
);
const ShareIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"></path>
    </svg>
);
const TrashIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path>
    </svg>
);
const CheckIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"></path>
    </svg>
);
const CheckDoubleIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d="M0.41 13.41L6 19l1.41-1.42L1.83 12 0.41 13.41zM22.41 5.41L12 15.83l-1.41-1.42L21 4 22.41 5.41zM18 7l-1.41-1.42L6 16.17 7.41 17.58 18 7z"></path>
    </svg>
);
const WifiOffIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364m12.728 0L5.636 5.636m12.728 12.728A9 9 0 105.636 5.636a9 9 0 0012.728 12.728z" />
    </svg>
);
const CopyIcon = (props: SVGProps<SVGSVGElement>) => (
    <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 8.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v8.25A2.25 2.25 0 006 16.5h2.25m8.25-8.25H18a2.25 2.25 0 012.25 2.25v8.25A2.25 2.25 0 0118 20.25h-8.25A2.25 2.25 0 017.5 18v-2.25m8.25-8.25l-6 6" />
    </svg>
);