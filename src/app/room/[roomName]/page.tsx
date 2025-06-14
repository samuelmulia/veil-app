"use client";

import React, { useEffect, useState, SVGProps, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Room,
  RoomEvent,
  Participant,
  ConnectionState,
  RemoteParticipant,
  DataPacket_Kind,
} from 'livekit-client';
import { AnimatePresence, motion } from 'framer-motion';

// --- Types ---
type VoiceNote = {
    id: string;
    sender: string;
    audioUrl: string;
    timestamp: number;
    isPlaying: boolean;
};

// --- Main Page Component ---
export default function VoiceNotesPage({ params }: { params: { roomName:string } }) {
    const [isInLobby, setIsInLobby] = useState(true);
    const [room, setRoom] = useState<Room | undefined>(undefined);
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [connectionError, setConnectionError] = useState<string | null>(null);
    const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
    const [isRecording, setIsRecording] = useState(false);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    
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
    
    // --- LiveKit Event Handling ---
    useEffect(() => {
        if (!room) return;

        const updateParticipantsList = () => {
            setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
        };

        const handleDataReceived = async (payload: Uint8Array, participant?: Participant) => {
            try {
                const blob = new Blob([payload], { type: 'audio/webm' });
                const audioUrl = URL.createObjectURL(blob);
                const newNote: VoiceNote = {
                    id: `vn-${Date.now()}-${Math.random()}`,
                    sender: participant?.identity || 'Unknown',
                    audioUrl,
                    timestamp: Date.now(),
                    isPlaying: false
                };
                setVoiceNotes(prev => [newNote, ...prev]);
            } catch (error) {
                console.error('Error processing received voice note:', error);
            }
        };

        updateParticipantsList();
        room.on(RoomEvent.ParticipantConnected, updateParticipantsList);
        room.on(RoomEvent.ParticipantDisconnected, updateParticipantsList);
        room.on(RoomEvent.DataReceived, handleDataReceived);

        return () => {
            room.off(RoomEvent.ParticipantConnected, updateParticipantsList);
            room.off(RoomEvent.ParticipantDisconnected, updateParticipantsList);
            room.off(RoomEvent.DataReceived, handleDataReceived);
        };
    }, [room]);

    const handleStartRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                audioChunksRef.current.push(event.data);
            };

            mediaRecorderRef.current.onstop = async () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const arrayBuffer = await audioBlob.arrayBuffer();
                
                if (room) {
                    // FIX: Convert ArrayBuffer to Uint8Array before publishing
                    await room.localParticipant.publishData(new Uint8Array(arrayBuffer), DataPacket_Kind.RELIABLE);
                }
                
                // Clean up stream tracks
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (error) {
            console.error("Error starting recording:", error);
            setConnectionError("Could not start recording. Check microphone permissions.");
        }
    };

    const handleStopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    const handlePlayPause = (noteId: string) => {
        setVoiceNotes(prev => prev.map(note => {
            if (note.id === noteId) {
                const audio = new Audio(note.audioUrl);
                if (!note.isPlaying) {
                    audio.play();
                } 
                return { ...note, isPlaying: !note.isPlaying };
            }
            return { ...note, isPlaying: false }; 
        }));
    };
    
    return (
        <div className="bg-[#080808] text-white min-h-screen flex flex-col">
            {isInLobby ? (
                <Lobby 
                  onEnterRoom={handleEnterRoom} 
                  connectionError={connectionError}
                  roomName={roomName}
                  isConnecting={room?.state === ConnectionState.Connecting}
                />
            ) : (
                <InCall
                    roomName={roomName}
                    participants={participants}
                    voiceNotes={voiceNotes}
                    isRecording={isRecording}
                    onStartRecording={handleStartRecording}
                    onStopRecording={handleStopRecording}
                    onPlayPause={handlePlayPause}
                    localParticipant={room?.localParticipant}
                />
            )}
        </div>
    );
}

// --- UI Components ---
const Lobby = ({ onEnterRoom, connectionError, roomName, isConnecting }: any) => {
  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-[#111] p-8 rounded-2xl flex flex-col border border-[#222]">
          <h2 className="text-2xl font-bold mb-2 text-center">Voice Notes Room</h2>
          <p className="text-center text-gray-400 mb-8">Room: <span className="font-bold text-white">{roomName}</span></p>
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

const InCall = ({ roomName, participants, voiceNotes, isRecording, onStartRecording, onStopRecording, onPlayPause, localParticipant }: any) => {
    return (
        <div className="flex-1 flex flex-col p-4 md:p-6 max-w-4xl mx-auto w-full">
            <header className="mb-6">
                 <h1 className="text-3xl font-bold text-white">Voice Notes</h1>
                 <p className="text-gray-400">You are <span className="font-mono bg-[#222] px-2 py-1 rounded">{localParticipant?.identity}</span> in room <span className="font-bold text-white">{roomName}</span></p>
                 <p className="text-gray-400 text-sm mt-2">Participants: {participants.map((p: Participant) => p.identity).join(', ')}</p>
            </header>
            <div className="flex-1 bg-[#111] rounded-2xl p-4 overflow-y-auto mb-6 border border-[#222]">
                <AnimatePresence>
                    {voiceNotes.length === 0 && (
                        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full text-gray-500">
                            <MessageSquareIcon className="w-16 h-16 mb-4" />
                            <p>No voice notes yet.</p>
                            <p>Press and hold the record button to start.</p>
                        </motion.div>
                    )}
                    {voiceNotes.map(note => (
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
            <footer className="flex justify-center items-center p-4">
                <button
                    onMouseDown={onStartRecording}
                    onMouseUp={onStopRecording}
                    onTouchStart={onStartRecording}
                    onTouchEnd={onStopRecording}
                    className={`record-btn w-24 h-24 rounded-full flex items-center justify-center transition-all duration-200 ease-in-out ${isRecording ? 'recording' : ''}`}
                >
                    <MicIcon className="w-10 h-10 text-white" />
                </button>
            </footer>
             <style jsx>{`
                .record-btn {
                    background: #dc2626;
                    box-shadow: 0 0 0 0 rgba(220, 38, 38, 1);
                }
                .record-btn.recording {
                    animation: pulse-red 2s infinite;
                    transform: scale(1.1);
                }
                @keyframes pulse-red {
                    0% {
                        transform: scale(0.95);
                        box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7);
                    }
                    70% {
                        transform: scale(1.1);
                        box-shadow: 0 0 0 25px rgba(220, 38, 38, 0);
                    }
                    100% {
                        transform: scale(0.95);
                        box-shadow: 0 0 0 0 rgba(220, 38, 38, 0);
                    }
                }
            `}</style>
        </div>
    );
};


// --- SVG Icons ---
const MicIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path> </svg> );
const PlayIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M8 5v14l11-7z"></path> </svg> );
const PauseIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path> </svg> );
const CheckIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path> </svg> );
const CopyIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path> </svg> );
const MessageSquareIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path strokeLinecap="round" strokeLinejoin="round" d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path> </svg> );

