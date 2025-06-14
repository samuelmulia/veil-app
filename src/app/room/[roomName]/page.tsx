"use client";

import React, { useEffect, useState, SVGProps, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Room,
  RoomEvent,
  Participant,
  ConnectionState,
  RemoteTrack,
  DataPacket_Kind,
  LocalParticipant,
  RemoteParticipant,
  RemoteTrackPublication,
  TrackPublication,
} from 'livekit-client';
import { AnimatePresence, motion } from 'framer-motion';

// --- Voice Options Data ---
const voiceOptions = [
    { id: 'original', name: 'Original Voice' },
    { id: 'agent_alpha', name: 'Agent Alpha (Deep)' },
    { id: 'agent_delta', name: 'Agent Delta (High)' },
    { id: 'synthetic', name: 'Synthetic' },
    { id: 'spectral', name: 'Spectral' },
];

// --- Language Options Data ---
const languageOptions = [
    { id: 'en-US', name: 'English' },
    { id: 'id-ID', name: 'Bahasa Indonesia' },
];

// --- Types ---
type Subtitle = {
    speakerName: string;
    text: string;
    timestamp: number;
};

// --- Speech Recognition Manager ---
class SpeechRecognitionManager {
    private recognition: any;
    private isActive: boolean = false;
    private restartAttempts: number = 0;
    private maxRestartAttempts: number = 5;
    private restartDelay: number = 1000;

    constructor(
        private language: string,
        private onResult: (text: string, isFinal: boolean) => void,
        private onError: (error: any) => void
    ) {
        this.initializeRecognition();
    }

    private initializeRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            this.onError(new Error("Speech Recognition not supported"));
            return;
        }

        this.recognition = new SpeechRecognition();
        this.recognition.lang = this.language;
        this.recognition.continuous = true;
        this.recognition.interimResults = true;

        this.recognition.onresult = (event: any) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }
            
            if (interimTranscript.length > 0) {
                this.onResult(interimTranscript, false);
            }

            if (finalTranscript) {
                this.onResult(finalTranscript, true);
                this.restartAttempts = 0;
            }
        };

        this.recognition.onend = () => {
            if (this.isActive && this.restartAttempts < this.maxRestartAttempts) {
                setTimeout(() => {
                    if (this.isActive) {
                        this.restartAttempts++;
                        try {
                            this.recognition.start();
                        } catch (e) {
                            console.error("Error restarting speech recognition:", e);
                        }
                    }
                }, this.restartDelay);
            }
        };
        
        this.recognition.onerror = (event: any) => {
            console.error("Speech recognition error:", event.error);
            this.onError(event.error);
            if (event.error === 'no-speech' || event.error === 'audio-capture') {
                this.restartAttempts++;
            }
        };
    }

    start() {
        if (!this.recognition || this.isActive) return;
        
        this.isActive = true;
        this.restartAttempts = 0;
        try {
            this.recognition.start();
        } catch (e) {
            console.error("Error starting speech recognition:", e);
            this.onError(e);
        }
    }

    stop() {
        this.isActive = false;
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch (e) {
                console.error("Error stopping speech recognition:", e);
            }
        }
    }

    dispose() {
        this.stop();
        this.recognition = null;
    }
}

// --- Debounce utility ---
function debounce<T extends (...args: any[]) => any>(func: T, delay: number): T {
    let timeoutId: NodeJS.Timeout;
    return ((...args: Parameters<T>) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func(...args), delay);
    }) as T;
}

// --- Main Page Component ---
export default function RoomPage({ params }: { params: { roomName:string } }) {
    const [isInLobby, setIsInLobby] = useState(true);
    const [isMuted, setIsMuted] = useState(false);
    const [selectedVoice, setSelectedVoice] = useState('original');
    const [selectedLanguage, setSelectedLanguage] = useState('en-US');
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isSubtitlesEnabled, setIsSubtitlesEnabled] = useState(true);
    const [activeSubtitle, setActiveSubtitle] = useState<Subtitle | null>(null);
    const subtitleTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const [room, setRoom] = useState<Room | undefined>(undefined);
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [speakingParticipants, setSpeakingParticipants] = useState<Participant[]>([]);
    const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
    const [connectionError, setConnectionError] = useState<string | null>(null);

    const audioContainerRef = useRef<HTMLDivElement>(null);
    const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

    const speakingSids = useMemo(
        () => new Set(speakingParticipants.map(p => p.sid)),
        [speakingParticipants]
    );

    const router = useRouter();
    const roomName = params.roomName;

    const updateSubtitle = useMemo(
        () => debounce((subtitle: Subtitle) => {
            setActiveSubtitle(subtitle);
            if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
            subtitleTimeoutRef.current = setTimeout(() => setActiveSubtitle(null), 5000);
        }, 100),
        []
    );

    const handleEnterRoom = async () => {
        setConnectionError(null);
        const identity = `user-${Math.random().toString(36).substring(7)}`;
        
        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });

            const resp = await fetch(`/api/token?roomName=${roomName}&identity=${identity}`);
            if (!resp.ok) {
                const errorData = await resp.json().catch(() => ({ message: 'Failed to get access token.' }));
                throw new Error(errorData.message || 'Failed to get access token.');
            }
            const { token } = await resp.json();

            const newRoom = new Room({ adaptiveStream: true, dynacast: true });
            const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
            if (!wsUrl) throw new Error("LiveKit URL is not configured.");
            
            await newRoom.connect(wsUrl, token);
            await newRoom.localParticipant.setMicrophoneEnabled(true);
            setIsMuted(false);

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

    // --- LiveKit Core Event Handling ---
    useEffect(() => {
        if (!room) return;

        const updateParticipantsList = () => {
            setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
        };
        
        const handleTrackSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
            if (track.kind === 'audio' && audioContainerRef.current) {
                const audioElement = track.attach();
                audioContainerRef.current.appendChild(audioElement);
                audioElementsRef.current.set(participant.sid, audioElement);
            }
        };
        
        const handleTrackUnsubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
             const audioElement = audioElementsRef.current.get(participant.sid);
             if(audioElement) {
                audioElement.remove();
                audioElementsRef.current.delete(participant.sid);
             }
        };

        const handleParticipantConnected = (participant: RemoteParticipant) => {
            updateParticipantsList();
            participant.on(RoomEvent.TrackPublished, (publication) => {
                if (publication.kind === 'audio') {
                    publication.setSubscribed(true);
                }
            });
        };
        
        const handleParticipantDisconnected = (participant: RemoteParticipant) => {
            updateParticipantsList();
            const audioElement = audioElementsRef.current.get(participant.sid);
            if (audioElement) {
                audioElement.remove();
                audioElementsRef.current.delete(participant.sid);
            }
        };

        updateParticipantsList();
        
        room.remoteParticipants.forEach(handleParticipantConnected);
        room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
        room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
        room.on(RoomEvent.ConnectionStateChanged, setConnectionState);
        room.on(RoomEvent.ActiveSpeakersChanged, setSpeakingParticipants);
        room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
        room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

        return () => {
            room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
            room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
            room.off(RoomEvent.ConnectionStateChanged, setConnectionState);
            room.off(RoomEvent.ActiveSpeakersChanged, setSpeakingParticipants);
            room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
            room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
        };
    }, [room]);
    
    // --- LiveKit Data (Subtitle) Event Handling ---
    useEffect(() => {
        if (!room) return;

        const handleDataReceived = (payload: Uint8Array, participant?: Participant) => {
            if (!isSubtitlesEnabled) return;
            try {
                const decoder = new TextDecoder();
                const data = JSON.parse(decoder.decode(payload));
                if (typeof data.text !== 'string') return;
                updateSubtitle({
                    speakerName: participant?.identity || 'Unknown',
                    text: data.text,
                    timestamp: Date.now()
                });
            } catch (error) {
                console.error('Error processing subtitle data:', error);
            }
        };

        room.on(RoomEvent.DataReceived, handleDataReceived);
        return () => {
            room.off(RoomEvent.DataReceived, handleDataReceived);
        }
    }, [room, isSubtitlesEnabled, updateSubtitle]);

    // --- Speech Recognition Logic ---
    useEffect(() => {
        let recognitionManager: SpeechRecognitionManager | null = null;
        
        const shouldBeRecognizing = !isInLobby && room && !isMuted && isSubtitlesEnabled;

        if (shouldBeRecognizing) {
            recognitionManager = new SpeechRecognitionManager(
                selectedLanguage,
                (text, isFinal) => {
                    updateSubtitle({ speakerName: 'You', text, timestamp: Date.now() });
                    if (isFinal && room) {
                        try {
                            const encoder = new TextEncoder();
                            const data = encoder.encode(JSON.stringify({ text }));
                            room.localParticipant.publishData(data, { reliable: true });
                        } catch (error) {
                            console.error('Error publishing data:', error);
                        }
                    }
                },
                (error) => {
                    console.error('Speech recognition error from manager:', error);
                }
            );
            recognitionManager.start();
        }

        return () => {
            recognitionManager?.dispose();
        };
    }, [isInLobby, room, isMuted, isSubtitlesEnabled, selectedLanguage, updateSubtitle]);


    const handleLeaveRoom = useCallback(() => {
        room?.disconnect();
        router.push('/');
    }, [room, router]);

    const toggleMute = useCallback(() => {
        const newMutedState = !isMuted;
        setIsMuted(newMutedState);
        room?.localParticipant.setMicrophoneEnabled(!newMutedState).catch(error => {
            console.error('Error toggling microphone:', error);
            setIsMuted(isMuted);
        });
    }, [isMuted, room]);

    return (
        <>
            <div ref={audioContainerRef} style={{ display: 'none' }} />
            {isInLobby ? (
                <Lobby 
                  onEnterRoom={handleEnterRoom} 
                  connectionError={connectionError}
                  {...{ roomName, isConnecting: connectionState === ConnectionState.Connecting, isMuted, toggleMute, selectedVoice, setSelectedVoice }} 
                />
            ) : (
                <InCall
                    onLeaveRoom={handleLeaveRoom}
                    onToggleSettings={() => setIsSettingsOpen(!isSettingsOpen)}
                    isSubtitlesEnabled={isSubtitlesEnabled}
                    onToggleSubtitles={() => setIsSubtitlesEnabled(!isSubtitlesEnabled)}
                    activeSubtitle={activeSubtitle}
                    speakingSids={speakingSids}
                    {...{ participants, localParticipantSid: room?.localParticipant.sid, isMuted, toggleMute, isSettingsOpen, selectedVoice, setSelectedVoice, selectedLanguage, setSelectedLanguage }}
                />
            )}
        </>
    );
}

// --- UI Components ---
const Lobby = React.memo(function Lobby({ roomName, isConnecting, isMuted, toggleMute, selectedVoice, setSelectedVoice, onEnterRoom, connectionError }: any) {
  const [isCopied, setIsCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const textArea = document.createElement("textarea");
    textArea.value = window.location.href;
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
        setIsCopied(true);
    } catch (err) {
        console.error('Failed to copy text: ', err);
    }
    document.body.removeChild(textArea);
    setTimeout(() => setIsCopied(false), 2000);
  }, []);

  return (
    <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
      <div className="w-full max-w-md">
        <div className="bg-[#080808] p-8 rounded-2xl flex flex-col floating-glow border border-[#222]">
          <h2 className="text-2xl font-bold mb-8 text-center">Configure Your Voice</h2>
          <div className="mb-6">
            <label className="text-sm text-gray-400">Share this Room Link</label>
            <div className="flex items-center mt-2 bg-[#111] rounded-xl p-3 border border-[#333]">
              <span className="font-mono text-sm text-white mr-4 truncate">{typeof window !== 'undefined' ? window.location.href : ''}</span>
              <button onClick={handleCopy} className="ml-auto bg-gray-700 hover:bg-gray-600 text-white font-semibold p-2 rounded-lg text-sm flex items-center">
                {isCopied ? <CheckIcon className="w-5 h-5" /> : <CopyIcon className="w-5 h-5" />}
              </button>
            </div>
          </div>
          <div className="mb-8 flex-grow">
            <h3 className="text-lg font-semibold mb-3">Choose Your Voice Effect</h3>
            <VoiceOptions selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
          </div>
          <div className="mt-auto">
            <div className="flex items-center justify-center mb-8">
              <button onClick={toggleMute} className={`control-btn p-4 rounded-full ${!isMuted ? 'active' : ''}`}>
                {isMuted ? <MicOffIcon className="w-6 h-6" /> : <MicIcon className="w-6 h-6" />}
              </button>
            </div>
            {connectionError && (
              <div className="bg-red-900/50 border border-red-500/50 text-red-200 p-3 rounded-lg mb-4 text-sm text-center">
                <strong>Connection Failed:</strong> {connectionError}
              </div>
            )}
            <button onClick={onEnterRoom} disabled={isConnecting} className="btn-primary w-full font-bold py-4 rounded-xl text-lg disabled:opacity-50 disabled:cursor-not-allowed">
              {isConnecting ? 'Connecting...' : 'Enter Anonymous Room'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

const ParticipantItem = React.memo(function ParticipantItem({ participant, isSpeaking, isYou }: { participant: Participant, isSpeaking: boolean, isYou: boolean }) {
    return (
        <div className={`p-4 rounded-2xl flex items-center justify-between transition-all duration-300 ${isSpeaking ? 'bg-[#1C1C1E] gradient-border-active' : 'bg-[#111] border border-[#222]'}`}>
            <span className={`font-bold text-lg ${isSpeaking ? 'text-white' : 'text-gray-400'}`}>
                {isYou ? 'You' : participant.identity} {isSpeaking && !isYou && '(Speaking)'}
            </span>
            <div className="text-gray-500">
                {isSpeaking ? <SoundOnIcon className="w-6 h-6 text-white" /> : <MicIcon className="w-6 h-6 text-gray-600" />}
            </div>
        </div>
    );
});

function InCall({ participants, speakingSids, localParticipantSid, isMuted, toggleMute, onLeaveRoom, onToggleSettings, isSettingsOpen, selectedVoice, setSelectedVoice, isSubtitlesEnabled, onToggleSubtitles, activeSubtitle, selectedLanguage, setSelectedLanguage }: any) {
    return (
        <div className="relative min-h-screen p-4 md:p-8 flex flex-col items-center justify-center overflow-hidden">
            {isSettingsOpen && ( <SettingsModal onClose={onToggleSettings} {...{ selectedVoice, setSelectedVoice, selectedLanguage, setSelectedLanguage }} /> )}
            <div className="w-full max-w-2xl text-center z-10">
                <h2 className="text-3xl font-bold mb-8">In Conversation</h2>
                <div className="space-y-4">
                    {participants.length > 0 ? participants.map((p: Participant) => {
                        const isSpeaking = speakingSids.has(p.sid);
                        const isYou = p.sid === localParticipantSid;
                        return (
                            <ParticipantItem 
                                key={p.sid} 
                                participant={p} 
                                isSpeaking={isSpeaking} 
                                isYou={isYou} 
                            />
                        );
                    }) : <p className="text-gray-500">Connecting to the room...</p>}
                    {participants.length === 1 && <p className="text-gray-500 mt-4">You're the first one here. Share the link to invite others.</p>}
                </div>
            </div>
            <SubtitleDisplay activeSubtitle={activeSubtitle} isEnabled={isSubtitlesEnabled} />
            <div className="fixed bottom-8 flex justify-center w-full z-20">
                <div className="control-bar flex items-center space-x-3 p-2 rounded-full">
                    <button onClick={toggleMute} className={`control-btn p-3 rounded-full ${!isMuted ? 'active' : ''}`}>
                        {isMuted ? <MicOffIcon className="w-6 h-6" /> : <MicIcon className="w-6 h-6" />}
                    </button>
                    <button onClick={onToggleSettings} className="control-btn p-3 rounded-full">
                        <SettingsIcon className="w-6 h-6" />
                    </button>
                    <button onClick={onToggleSubtitles} className={`control-btn p-3 rounded-full ${isSubtitlesEnabled ? 'active' : ''}`}>
                        <SubtitlesIcon className={`w-6 h-6 transition-colors ${isSubtitlesEnabled ? 'text-white' : 'text-gray-400'}`} />
                    </button>
                    <button onClick={onLeaveRoom} className="control-btn red p-3 rounded-full">
                        <EndCallIcon className="w-6 h-6" />
                    </button>
                </div>
            </div>
        </div>
    );
}

const SubtitleDisplay = React.memo(function SubtitleDisplay({ activeSubtitle, isEnabled }: { activeSubtitle: Subtitle | null, isEnabled: boolean }) {
    if (!isEnabled) return null;
    return (
        <div className="absolute bottom-24 left-0 right-0 flex justify-center items-center px-4 z-10 pointer-events-none">
            <AnimatePresence>
                {activeSubtitle && (
                    <motion.div
                        key={activeSubtitle.timestamp}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        transition={{ ease: "easeInOut", duration: 0.3 }}
                        className="bg-black/60 backdrop-blur-sm text-white p-3 rounded-lg max-w-3xl text-center"
                    >
                        <p className="font-bold text-lg">{activeSubtitle.speakerName}: <span className="font-normal">{activeSubtitle.text}</span></p>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
});

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

const LanguageOptions = React.memo(function LanguageOptions({ selectedLanguage, setSelectedLanguage }: any) {
    return (
        <div className="flex space-x-2">
            {languageOptions.map((option) => (
                <button
                    key={option.id}
                    onClick={() => setSelectedLanguage(option.id)}
                    className={`flex-1 py-2 px-4 rounded-lg transition-colors text-sm font-semibold ${selectedLanguage === option.id ? 'bg-white text-black' : 'bg-[#2a2a2a] text-white hover:bg-[#3a3a3a]'}`}
                >
                    {option.name}
                </button>
            ))}
        </div>
    );
});

const SettingsModal = React.memo(function SettingsModal({ onClose, selectedVoice, setSelectedVoice, selectedLanguage, setSelectedLanguage }: any) {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-[#080808] p-8 rounded-2xl border border-[#222] floating-glow w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold mb-4">Change Voice Effect</h3>
                <VoiceOptions selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
                
                <h3 className="text-lg font-semibold mb-4 mt-6">Subtitle Language</h3>
                <LanguageOptions selectedLanguage={selectedLanguage} setSelectedLanguage={setSelectedLanguage} />

                <button onClick={onClose} className="btn-secondary w-full mt-8 py-2 rounded-lg">Close</button>
            </div>
        </div>
    );
});

// --- SVG Icons ---
const MicIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path> </svg> );
const MicOffIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.55-.9L19.73 21 21 19.73 4.27 3z"></path> </svg> );
const EndCallIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.21-3.73-6.56-6.56l1.97-1.57c.27-.27.36-.66.24-1.01-.37-1.11-.56-2.3-.56-3.53c0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99c0 8.27 6.73 15 15 15c.75 0 .99-.65.99-1.19v-2.42c0-.54-.45-.99-.99-.99z"></path> </svg> );
const SettingsIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.438.995s.145.755.438.995l1.003.827c.48.398.638 1.04.26 1.431l-1.296 2.247a1.125 1.125 0 01-1.37.49l-1.217-.456c-.355-.133-.75-.072-1.075.124a6.57 6.57 0 01-.22.127c-.331.183-.581.495-.644.87l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.37-.49l-1.296-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.437-.995s-.145-.755-.437-.995l-1.004-.827a1.125 1.125 0 01-.26-1.431l1.296-2.247a1.125 1.125 0 011.37-.49l1.217.456c.355.133.75.072 1.076-.124.072-.044.146-.087.22-.127.332-.183.582-.495.644-.87l.213-1.281z" /> <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /> </svg>);
const CopyIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path> </svg> );
const CheckIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path> </svg> );
const SoundOnIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"></path> </svg> );
const SubtitlesIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"></path> </svg> );
