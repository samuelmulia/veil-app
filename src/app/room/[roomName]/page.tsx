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
const CHUNK_SIZE = 30 * 1024; // 30 KB for more reliable transmission
const MAX_RECORDING_TIME = 60 * 1000; // 60 seconds
const CHUNK_RESEND_TIMEOUT = 10 * 1000; // 10 seconds to wait for missing chunks
const SENT_CHUNK_CACHE_DURATION = 30 * 1000; // Keep sent chunks for 30s for resend requests
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

interface SentChunksCache {
    [noteId: string]: {
        chunks: string[];
        timeoutId: NodeJS.Timeout;
    };
}

// Added new packet types for chunk resend/request mechanism
type Packet =
    | { type: 'voice-chunk'; noteId: string; chunk: string; index: number; total: number }
    | { type: 'voice-end'; noteId: string; totalChunks: number; effectId: string; duration: number }
    | { type: 'status'; status: 'recording' | 'idle' }
    | { type: 'delete-note'; noteId: string }
    | { type: 'status-update'; noteId: string; status: NoteStatus }
    | { type: 'typing-indicator'; isTyping: boolean }
    | { type: 'request-chunks'; noteId: string; missingIndexes: number[] }
    | { type: 'chunk-resend'; noteId: string; chunk: string; index: number; total: number };


// --- Enhanced Audio Utilities ---
class AudioProcessor {
    private static audioContext: AudioContext | null = null;

    static getAudioContext(): AudioContext {
        if (!this.audioContext || this.audioContext.state === 'closed') {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        }
        return this.audioContext;
    }

    static async applyVoiceEffect(audioBlob: Blob, effectId: string): Promise<Blob> {
        try {
            const audioContext = this.getAudioContext();
            // Create a copy of the buffer to prevent corruption, as decodeAudioData can transfer ownership
            const arrayBuffer = await audioBlob.arrayBuffer();
            if (arrayBuffer.byteLength === 0) {
                throw new Error("Cannot process empty audio blob.");
            }

            const sourceAudioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

            const offlineContext = new OfflineAudioContext(
                sourceAudioBuffer.numberOfChannels,
                sourceAudioBuffer.length,
                sourceAudioBuffer.sampleRate
            );

            const source = offlineContext.createBufferSource();
            source.buffer = sourceAudioBuffer;

            // Add dynamic range compression to prevent clipping and normalize volume
            const compressor = offlineContext.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(-50, offlineContext.currentTime);
            compressor.knee.setValueAtTime(40, offlineContext.currentTime);
            compressor.ratio.setValueAtTime(12, offlineContext.currentTime);
            compressor.attack.setValueAtTime(0, offlineContext.currentTime);
            compressor.release.setValueAtTime(0.25, offlineContext.currentTime);

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
            source.connect(compressor);
            compressor.connect(offlineContext.destination);
            source.start(0);

            const renderedBuffer = await offlineContext.startRendering();
            const wavBuffer = this.bufferToWav(renderedBuffer);
            return new Blob([wavBuffer], { type: 'audio/wav' });
        } catch (error) {
            console.error('Voice effect processing failed:', error);
            return audioBlob; // Return original blob if processing fails
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
        const chunkSize = 0x8000;
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
                if (event.data.size > 0) audioChunksRef.current.push(event.data);
            };
            mediaRecorderRef.current.onstop = () => {
                streamRef.current?.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            };
            mediaRecorderRef.current.start();
            setRecordingStatus('recording');
            setRecordingTime(0);
            const startTime = Date.now();
            recordingTimerRef.current = setInterval(() => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                setRecordingTime(elapsed);
                if (elapsed >= MAX_RECORDING_TIME / 1000) stopRecording();
            }, 100);
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
        if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop();
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
        setRecordingStatus('idle');
        setRecordingTime(0);
        audioChunksRef.current = [];
    }, []);

    return { recordingStatus, setRecordingStatus, recordingTime, startRecording, stopRecording, resetRecording };
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
    const [isOnline, setIsOnline] = useState(navigator.onLine);
    const [sendingProgress, setSendingProgress] = useState(0);

    const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
    const receivedChunksRef = useRef<Record<string, { chunks: (string | null)[]; endPacket: Packet & { type: 'voice-end' } | null; timeoutId?: NodeJS.Timeout }>>({});
    const sentChunksCacheRef = useRef<SentChunksCache>({});
    const router = useRouter();
    const roomName = params.roomName;

    const { notification, showNotification } = useNotifications();
    const { recordingStatus, setRecordingStatus, recordingTime, startRecording, stopRecording, resetRecording } = useAudioRecorder();

    // Network status monitoring
    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => {
            setIsOnline(false);
            showNotification("You're offline. Please check your connection.", 5000);
        };
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, [showNotification]);

    const handleEnterRoom = async () => {
        if (!isOnline) {
            showNotification('Please check your internet connection');
            return;
        }
        setConnectionStatus('connecting');
        const identity = `user-${Math.random().toString(36).substring(7).slice(0, 5)}`;
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            const resp = await fetch(`/api/token?roomName=${encodeURIComponent(roomName)}&identity=${encodeURIComponent(identity)}`);
            if (!resp.ok) throw new Error(`Failed to get token: ${resp.status} ${resp.statusText}`);
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

    const broadcastPacket = useCallback(async (packet: Packet, reliable = true) => {
        if (!room || room.state !== ConnectionState.Connected) {
            console.warn('Cannot broadcast: room not connected');
            return false;
        }
        try {
            const data = new TextEncoder().encode(JSON.stringify(packet));
            // Retry logic with exponential backoff for sending important packets
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts) {
                try {
                    await room.localParticipant.publishData(data, { reliable });
                    return true;
                } catch (e) {
                    attempts++;
                    if (attempts >= maxAttempts) throw e;
                    const delay = Math.pow(2, attempts) * 100; // 100ms, 200ms, 400ms
                    await new Promise(res => setTimeout(res, delay));
                }
            }
            return false;
        } catch (error) {
            console.error("Failed to broadcast packet:", error);
            showNotification("Message could not be sent.", 3000);
            return false;
        }
    }, [room, showNotification]);

    const processCompleteNote = useCallback(async (noteId: string) => {
        const transferData = receivedChunksRef.current[noteId];
        if (!transferData || !transferData.endPacket) return;

        const { chunks, endPacket } = transferData;
        const noteExists = voiceNotes.some(note => note.id === noteId);
        if (noteExists) {
            delete receivedChunksRef.current[noteId];
            return;
        }

        console.log(`Processing complete note ${noteId}`);
        const fullBase64 = chunks.join('');
        const audioBuffer = EncodingUtils.base64ToArrayBuffer(fullBase64);
        const audioBlob = new Blob([audioBuffer], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(audioBlob);

        const newNote: VoiceNote = {
            id: endPacket.noteId,
            sender: { id: "unknown", name: "unknown" }, // Placeholder, will be set in handleDataReceived
            audioUrl,
            timestamp: Date.now(),
            isPlaying: false,
            status: 'delivered',
            duration: endPacket.duration,
        };

        setVoiceNotes(prev => [newNote, ...prev]);
        broadcastPacket({ type: 'status-update', noteId: newNote.id, status: 'delivered' });
        delete receivedChunksRef.current[noteId];
    }, [broadcastPacket, voiceNotes]);

    const handleIncompleteTransfer = useCallback((noteId: string) => {
        console.error(`Transfer for note ${noteId} timed out and failed.`);
        showNotification("Failed to receive a voice note.", 4000);
        if (receivedChunksRef.current[noteId]?.timeoutId) {
            clearTimeout(receivedChunksRef.current[noteId].timeoutId);
        }
        delete receivedChunksRef.current[noteId];
    }, [showNotification]);

    useEffect(() => {
        if (!room) return;

        const handleParticipantUpdate = () => setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);

        const handleParticipantConnected = (p: Participant) => {
            showNotification(`${p.identity} joined`);
            handleParticipantUpdate();
        };

        const handleParticipantDisconnected = (p: Participant) => {
            showNotification(`${p.identity} left`);
            handleParticipantUpdate();
            setRecordingParticipants(prev => {
                const newState = { ...prev };
                delete newState[p.identity];
                return newState;
            });
        };

        const handleDataReceived = async (payload: Uint8Array, participant?: Participant) => {
            if (!participant) return;

            try {
                const packet = JSON.parse(new TextDecoder().decode(payload)) as Packet;

                // Set sender info for later processing
                const getSender = () => ({ id: participant.sid, name: participant.identity });

                switch (packet.type) {
                    case 'voice-chunk':
                    case 'chunk-resend': {
                        if (!receivedChunksRef.current[packet.noteId]) {
                            receivedChunksRef.current[packet.noteId] = {
                                chunks: new Array(packet.total).fill(null),
                                endPacket: null
                            };
                        }
                        receivedChunksRef.current[packet.noteId].chunks[packet.index] = packet.chunk;

                        const transferData = receivedChunksRef.current[packet.noteId];
                        if (transferData.endPacket && !transferData.chunks.includes(null)) {
                            if (transferData.timeoutId) clearTimeout(transferData.timeoutId);
                            processCompleteNote(packet.noteId).then(() => {
                                setVoiceNotes(prev => prev.map(n => n.id === packet.noteId ? { ...n, sender: getSender() } : n));
                            });
                        }
                        break;
                    }

                    case 'voice-end': {
                        const { noteId, totalChunks } = packet;
                        if (!receivedChunksRef.current[noteId]) {
                            receivedChunksRef.current[noteId] = {
                                chunks: new Array(totalChunks).fill(null),
                                endPacket: packet,
                            };
                        } else {
                             receivedChunksRef.current[noteId].endPacket = packet;
                        }

                        const transferData = receivedChunksRef.current[noteId];
                        const receivedCount = transferData.chunks.filter(c => c !== null).length;
                        
                        if (receivedCount === totalChunks) {
                             if (transferData.timeoutId) clearTimeout(transferData.timeoutId);
                             processCompleteNote(noteId).then(() => {
                                setVoiceNotes(prev => prev.map(n => n.id === noteId ? { ...n, sender: getSender() } : n));
                            });
                        } else {
                            const missingIndexes = transferData.chunks
                                .map((c, i) => c === null ? i : -1)
                                .filter(i => i !== -1);

                            console.log(`Requesting ${missingIndexes.length} missing chunks for ${noteId}`);
                            broadcastPacket({ type: 'request-chunks', noteId, missingIndexes });
                            
                            // Set a timeout to fail the transfer if chunks don't arrive
                            transferData.timeoutId = setTimeout(() => {
                                handleIncompleteTransfer(noteId);
                            }, CHUNK_RESEND_TIMEOUT);
                        }
                        break;
                    }
                     
                    case 'request-chunks': {
                        const { noteId, missingIndexes } = packet;
                        const cached = sentChunksCacheRef.current[noteId];
                        if (cached) {
                            console.log(`Resending ${missingIndexes.length} chunks for ${noteId}`);
                            for (const index of missingIndexes) {
                                await broadcastPacket({
                                    type: 'chunk-resend',
                                    noteId,
                                    chunk: cached.chunks[index],
                                    index,
                                    total: cached.chunks.length,
                                }, false); // Resend unreliable to not block main channel
                                await new Promise(res => setTimeout(res, 20)); // Small delay
                            }
                        }
                        break;
                    }
                        
                    case 'status':
                        setRecordingParticipants(prev => ({ ...prev, [participant.identity]: packet.status === 'recording' }));
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
            const statusMap: Record<ConnectionState, ConnectionStatus> = {
                [ConnectionState.Connected]: 'connected',
                [ConnectionState.Connecting]: 'connecting',
                [ConnectionState.Reconnecting]: 'connecting',
                [ConnectionState.Disconnected]: 'disconnected'
            };
            setConnectionStatus(statusMap[state]);
            if(state === ConnectionState.Disconnected) showNotification('Disconnected from room');
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
    }, [room, broadcastPacket, showNotification, processCompleteNote, handleIncompleteTransfer]);

    const handleStartRecording = useCallback(async () => {
        const success = await startRecording();
        if (success) {
            broadcastPacket({ type: 'status', status: 'recording' });
        } else {
            showNotification('Failed to start recording. Check microphone permissions.');
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
            setSendingProgress(0);

            const base64Audio = EncodingUtils.arrayBufferToBase64(rawAudioBuffer);
            const noteId = `vn-${Date.now()}-${room.localParticipant.identity}`;
            const totalChunks = Math.ceil(base64Audio.length / CHUNK_SIZE);
            const chunks = [];

            // Cache chunks for potential resend requests
            for (let i = 0; i < totalChunks; i++) {
                chunks.push(base64Audio.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
            }
            const timeoutId = setTimeout(() => {
                delete sentChunksCacheRef.current[noteId];
            }, SENT_CHUNK_CACHE_DURATION);
            sentChunksCacheRef.current[noteId] = { chunks, timeoutId };

            // Send chunks sequentially
            for (let i = 0; i < totalChunks; i++) {
                const success = await broadcastPacket({
                    type: 'voice-chunk', noteId, chunk: chunks[i], index: i, total: totalChunks
                });
                if (!success) throw new Error(`Failed to send chunk ${i + 1}`);
                setSendingProgress(((i + 1) / totalChunks) * 100);
                if (i < totalChunks - 1) await new Promise(res => setTimeout(res, 50));
            }

            // Send end packet
            const endSuccess = await broadcastPacket({
                type: 'voice-end', noteId, totalChunks, effectId: selectedVoice, duration
            });
            if (!endSuccess) throw new Error('Failed to send voice-end packet');

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
            showNotification('Failed to send voice note. Please try again.', 5000);
            setVoiceNotes(prev => prev.map(n => n.sender.name === 'You' && n.status === 'sent' ? { ...n, status: 'failed' } : n));
        } finally {
            setRecordingStatus('idle');
            setSendingProgress(0);
            if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
            setLastRecording({ blob: null, url: null });
        }
    }, [lastRecording.blob, room, selectedVoice, broadcastPacket, showNotification]);

    const handleDiscardNote = useCallback(() => {
        if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
        setLastRecording({ blob: null, url: null });
        resetRecording();
        broadcastPacket({ type: 'status', status: 'idle' });
    }, [lastRecording.url, resetRecording, broadcastPacket]);

    const handlePlayPause = useCallback((noteId: string) => {
        const noteToPlay = voiceNotes.find(n => n.id === noteId);
        if (!noteToPlay) return;

        if (audioPlayerRef.current && !audioPlayerRef.current.paused) {
            const isSameNote = audioPlayerRef.current.dataset.noteId === noteId;
            audioPlayerRef.current.pause();
            if (isSameNote) return;
        }

        const newAudio = new Audio(noteToPlay.audioUrl);
        audioPlayerRef.current = newAudio;
        audioPlayerRef.current.dataset.noteId = noteId;

        newAudio.onplay = () => {
            setVoiceNotes(prev => prev.map(n => n.id === noteId ? { ...n, isPlaying: true } : { ...n, isPlaying: false }));
            if (noteToPlay.sender.name !== 'You' && noteToPlay.status !== 'played') {
                broadcastPacket({ type: 'status-update', noteId, status: 'played' });
            }
        };
        newAudio.onpause = newAudio.onended = () => {
            setVoiceNotes(prev => prev.map(n => n.id === noteId ? { ...n, isPlaying: false } : n));
        };
        newAudio.onerror = () => showNotification('Error playing voice note');
        newAudio.play().catch(e => {
            console.error("Audio play error:", e);
            showNotification('Could not play audio.');
        });
    }, [voiceNotes, broadcastPacket, showNotification]);

    const handleDeleteNote = useCallback((noteId: string) => {
        const noteToDelete = voiceNotes.find(n => n.id === noteId);
        if (noteToDelete?.audioUrl) URL.revokeObjectURL(noteToDelete.audioUrl);
        setVoiceNotes(prev => prev.filter(n => n.id !== noteId));
        broadcastPacket({ type: 'delete-note', noteId });
    }, [voiceNotes, broadcastPacket]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            room?.disconnect();
            voiceNotes.forEach(note => { if (note.audioUrl) URL.revokeObjectURL(note.audioUrl) });
            if (lastRecording.url) URL.revokeObjectURL(lastRecording.url);
            // Clear all pending timeouts and refs
            Object.values(receivedChunksRef.current).forEach(transfer => {
                if (transfer.timeoutId) clearTimeout(transfer.timeoutId);
            });
             Object.values(sentChunksCacheRef.current).forEach(cache => {
                if (cache.timeoutId) clearTimeout(cache.timeoutId);
            });
            receivedChunksRef.current = {};
            sentChunksCacheRef.current = {};
        };
    }, [room, voiceNotes, lastRecording.url]);

    return (
        <div className="bg-[#080808] text-white min-h-screen flex flex-col">
            <ConnectionNotification message={notification} />
            {!isOnline && (
                <div className="bg-red-600 text-white p-2 text-center text-sm">
                    <WifiOffIcon className="w-4 h-4 inline mr-2" />
                    You're offline. Some features may be unavailable.
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
                    sendingProgress={sendingProgress}
                />
            )}
        </div>
    );
}

// --- Enhanced UI Components ---

const Lobby = React.memo(({
    onEnterRoom,
    connectionStatus,
    roomName,
    selectedVoice,
    setSelectedVoice,
    isOnline
}: any) => {
    const handleShare = async () => {
        const text = `Join my anonymous voice chat room on Veil!\n\nRoom Name: ${roomName}\nLink: ${window.location.href}`;
        if (navigator.share) {
            try {
                await navigator.share({ title: 'Join Voice Notes Room', text: `Join room: ${roomName}`, url: window.location.href });
            } catch (error) {
                navigator.clipboard.writeText(text);
                alert('Room link copied to clipboard!');
            }
        } else {
            navigator.clipboard.writeText(text);
            alert('Room link and name copied to clipboard!');
        }
    };

    return (
        <div className="flex-1 flex items-center justify-center p-4">
            <div className="w-full max-w-md">
                <div className="bg-[#111] p-8 rounded-2xl flex flex-col border border-[#222]">
                    <div className="text-center mb-6">
                        <h2 className="text-2xl font-bold mb-2">Voice Notes Room</h2>
                        <div className="flex justify-center items-center gap-2 mb-4">
                            <p className="text-gray-400">Room: <span className="font-bold text-white">{roomName}</span></p>
                            <button onClick={handleShare} className="p-2 rounded-full hover:bg-gray-700 transition-colors" title="Share room">
                                <ShareIcon className="w-5 h-5"/>
                            </button>
                        </div>
                        <ConnectionStatusIndicator status={connectionStatus} />
                    </div>
                    <div className="mb-8 flex-grow">
                        <h3 className="text-lg font-semibold mb-3 text-center">Choose Your Anonymous Voice</h3>
                        <VoiceOptions selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
                    </div>
                    <button onClick={onEnterRoom} disabled={connectionStatus === 'connecting' || !isOnline} className="btn-primary w-full font-bold py-4 rounded-xl text-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all">
                        {connectionStatus === 'connecting' ? (
                            <div className="flex items-center justify-center gap-2"><LoadingSpinner />Connecting...</div>
                        ) : !isOnline ? 'Offline - Check Connection' : 'Join Room'}
                    </button>
                </div>
            </div>
        </div>
    );
});

const InCall = React.memo(({
    roomName, participants, voiceNotes, recordingStatus, recordingTime,
    onStartRecording, onStopRecording, onSendNote, onDiscardNote,
    lastRecordingUrl, onPlayPause, onDeleteNote, localParticipant,
    recordingParticipants, connectionStatus, sendingProgress
}: any) => {
    const reviewPlayerRef = useRef<HTMLAudioElement>(null);
    const hasPeers = participants.length > 1;

    const playReview = () => { if (reviewPlayerRef.current) reviewPlayerRef.current.play(); };
    const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
    const formatDuration = (duration?: number) => !duration ? '' : `${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}`;

    return (
        <div className="flex-1 flex flex-col p-4 md:p-6 max-w-4xl mx-auto w-full">
            <header className="mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-3xl font-bold text-white">Voice Notes</h1>
                    <ConnectionStatusIndicator status={connectionStatus} />
                </div>
                <p className="text-gray-400">You are <span className="font-mono bg-[#222] px-2 py-1 rounded">{localParticipant?.identity}</span> in room <span className="font-bold text-white">{roomName}</span></p>
                <div className="text-gray-400 text-sm mt-2">
                    <span className="font-bold">Participants ({participants.length}):</span>
                    <div className="flex flex-wrap gap-2 mt-1">
                        {participants.map((p: Participant) => (
                            <span key={p.sid} className="bg-[#222] px-2 py-1 rounded-full text-xs flex items-center gap-1">
                                {p.identity}
                                {p.sid !== localParticipant?.sid && recordingParticipants[p.identity] && <span className="text-red-500 font-bold animate-pulse">●</span>}
                            </span>
                        ))}
                    </div>
                </div>
            </header>
            <div className="flex-1 bg-[#111] rounded-2xl p-4 overflow-y-auto mb-6 border border-[#222] min-h-0">
                <AnimatePresence>
                    {!hasPeers && recordingStatus === 'idle' && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full text-gray-500">
                            <UsersIcon className="w-16 h-16 mb-4" />
                            <p className="font-bold text-lg">Waiting for others to join...</p>
                            <p className="text-sm mt-2">Share the room link to invite people</p>
                        </motion.div>
                    )}
                    {hasPeers && voiceNotes.length === 0 && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full text-gray-500">
                            <MessageSquareIcon className="w-16 h-16 mb-4" />
                            <p className="font-bold text-lg">No voice notes yet</p>
                            <p className="text-sm mt-2">Press the mic button to record</p>
                        </motion.div>
                    )}
                    {voiceNotes.map((note: VoiceNote) => (
                        <VoiceNoteItem key={note.id} note={note} onPlayPause={onPlayPause} onDelete={onDeleteNote} formatDuration={formatDuration} />
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
                sendingProgress={sendingProgress}
            />
        </div>
    );
});

const VoiceNoteItem = React.memo(({ note, onPlayPause, onDelete, formatDuration }: any) => (
    <motion.div
        layout key={note.id}
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
        className="flex items-center space-x-4 p-4 mb-3 bg-[#222] rounded-lg hover:bg-[#333] transition-colors"
    >
        <button onClick={() => onPlayPause(note.id)} className={`p-3 rounded-full transition-all ${note.isPlaying ? 'bg-yellow-500 hover:bg-yellow-400' : 'bg-blue-600 hover:bg-blue-500'}`}>
            {note.isPlaying ? <PauseIcon className="w-5 h-5 text-white" /> : <PlayIcon className="w-5 h-5 text-white" />}
        </button>
        <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
                <p className="font-bold text-white truncate">{note.sender.name}</p>
                {note.duration && <span className="text-xs text-gray-400 bg-[#444] px-2 py-1 rounded">{formatDuration(note.duration)}</span>}
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400">
                <span>{new Date(note.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                {note.sender.name === 'You' && <ReadReceipt status={note.status} />}
            </div>
        </div>
        {note.sender.name === 'You' && (
            <button onClick={() => onDelete(note.id)} className="p-2 text-gray-500 hover:text-red-500 transition-colors" title="Delete note">
                <TrashIcon className="w-5 h-5"/>
            </button>
        )}
    </motion.div>
));

const RecordingControls = React.memo(({
    recordingStatus, recordingTime, onStartRecording, onStopRecording,
    onSendNote, onDiscardNote, lastRecordingUrl, playReview,
    formatTime, reviewPlayerRef, sendingProgress
}: any) => (
    <footer className="flex justify-center items-center p-4 h-32">
        {recordingStatus === 'idle' && (
            <div className="text-center">
                <button onClick={onStartRecording} className="record-btn idle w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 ease-in-out hover:scale-105">
                    <MicIcon className="w-8 h-8 text-white" />
                </button>
                <p className="text-xs text-gray-400 mt-2">Tap to record</p>
            </div>
        )}
        {recordingStatus === 'recording' && (
            <div className="text-center">
                <button onClick={onStopRecording} className="record-btn recording w-20 h-20 rounded-full flex items-center justify-center transition-all">
                    <StopIcon className="w-8 h-8 text-white" />
                </button>
                <div className="mt-2 text-sm text-red-400 font-mono">{formatTime(recordingTime)}</div>
                <p className="text-xs text-gray-400">Recording... Tap to stop</p>
            </div>
        )}
        {recordingStatus === 'reviewing' && (
            <div className="flex items-center gap-4">
                <button onClick={onDiscardNote} className="bg-gray-600 hover:bg-gray-500 p-4 rounded-full transition-colors" title="Discard recording"><XIcon className="w-6 h-6 text-white"/></button>
                {lastRecordingUrl && <audio ref={reviewPlayerRef} src={lastRecordingUrl} />}
                <button onClick={playReview} className="bg-blue-600 hover:bg-blue-500 p-5 rounded-full transition-colors" title="Preview recording"><PlayIcon className="w-8 h-8 text-white"/></button>
                <button onClick={onSendNote} className="bg-green-600 hover:bg-green-500 p-4 rounded-full transition-colors" title="Send recording"><SendIcon className="w-6 h-6 text-white"/></button>
            </div>
        )}
        {recordingStatus === 'processing' && (
            <div className="text-center"><LoadingSpinner size="large" /><p className="text-gray-400 mt-2">Processing voice effect...</p></div>
        )}
        {recordingStatus === 'sending' && (
            <div className="text-center w-48">
                <div className="relative">
                     <LoadingSpinner size="large" />
                     <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center text-xs font-bold">{Math.round(sendingProgress)}%</div>
                </div>
                <p className="text-gray-400 mt-2">Sending voice note...</p>
            </div>
        )}
        <style jsx>{`
            .record-btn.idle { background: linear-gradient(135deg, #1e40af, #3b82f6); box-shadow: 0 4px 20px rgba(59, 130, 246, 0.3); }
            .record-btn.recording { background: linear-gradient(135deg, #dc2626, #ef4444); animation: pulse-red 2s infinite; }
            @keyframes pulse-red { 0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7); } 70% { box-shadow: 0 0 0 20px rgba(220, 38, 38, 0); } 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); } }
        `}</style>
    </footer>
));

const ConnectionNotification = ({ message }: { message: string | null }) => (
    <AnimatePresence>
        {message && (
            <motion.div
                initial={{ y: -100, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -100, opacity: 0 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className="fixed top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg z-50 max-w-sm text-center"
            >{message}</motion.div>
        )}
    </AnimatePresence>
);

const ConnectionStatusIndicator = ({ status }: { status: ConnectionStatus }) => {
    const statusConfig = {
        connected: { color: 'text-green-500', bg: 'bg-green-500', text: 'Connected' },
        connecting: { color: 'text-yellow-500', bg: 'bg-yellow-500 animate-pulse', text: 'Connecting...' },
        failed: { color: 'text-red-500', bg: 'bg-red-500', text: 'Connection Failed' },
        disconnected: { color: 'text-gray-500', bg: 'bg-gray-500', text: 'Disconnected' }
    };
    const { color, bg, text } = statusConfig[status] || statusConfig.disconnected;
    return (
        <div className={`flex items-center gap-2 text-sm ${color}`}>
            <div className={`w-2 h-2 rounded-full ${bg}`} />{text}
        </div>
    );
};

const VoiceOptions = React.memo(function VoiceOptions({ selectedVoice, setSelectedVoice }: any) {
    return (
        <div className="space-y-2">
            {voiceOptions.map((option) => (
                <div key={option.id} onClick={() => setSelectedVoice(option.id)}
                    className={`voice-option cursor-pointer p-3 rounded-lg border-l-4 flex items-center justify-between transition-all ${
                        selectedVoice === option.id ? 'selected bg-[#2a2a2a] border-blue-500 shadow-lg' : 'border-transparent hover:bg-[#1a1a1a] hover:border-gray-600'
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
    const statusMap = {
        played: { icon: <CheckDoubleIcon className="w-4 h-4 text-blue-400" />, text: <span className="text-blue-400">Played</span>, title: "Played" },
        delivered: { icon: <CheckDoubleIcon className="w-4 h-4 text-gray-500" />, text: <span>Delivered</span>, title: "Delivered" },
        failed: { icon: <XIcon className="w-4 h-4 text-red-500" />, text: <span className="text-red-500">Failed</span>, title: "Failed to send" },
        sent: { icon: <CheckIcon className="w-4 h-4 text-gray-500" />, text: <span>Sent</span>, title: "Sent" },
    };
    const { icon, text, title } = statusMap[status] || statusMap.sent;
    return <div className="flex items-center gap-1" title={title}>{icon}{text}</div>;
};

const LoadingSpinner = ({ size = 'medium' }: { size?: 'small' | 'medium' | 'large' }) => {
    const sizeClass = { small: 'w-4 h-4', medium: 'w-6 h-6', large: 'w-8 h-8' }[size];
    return <div className={`${sizeClass} border-2 border-gray-600 border-t-white rounded-full animate-spin`} />;
};

// --- Enhanced SVG Icons ---
const MicIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path></svg>);
const PlayIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M8 5v14l11-7z"></path></svg>);
const PauseIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>);
const StopIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M6 6h12v12H6z"></path></svg>);
const SendIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>);
const XIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"></path></svg>);
const MessageSquareIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path></svg>);
const UsersIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" {...props}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"></path></svg>);
const ShareIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3s3-1.34 3-3-1.34-3-3-3z"></path></svg>);
const TrashIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"></path></svg>);
const CheckIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"></path></svg>);
const CheckDoubleIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M0.41 13.41L6 19l1.41-1.42L1.83 12 0.41 13.41zM22.41 5.41L12 15.83l-1.41-1.42L21 4 22.41 5.41zM18 7l-1.41-1.42L6 16.17 7.41 17.58 18 7z"></path></svg>);
const WifiOffIcon = (props: SVGProps<SVGSVGElement>) => (<svg fill="currentColor" viewBox="0 0 24 24" {...props}><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.07 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.86 9.14 5 13z"></path></svg>);