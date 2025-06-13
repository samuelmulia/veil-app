"use client";

import { useEffect, useState, SVGProps, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Room,
  RoomEvent,
  Participant,
  ConnectionState,
  RemoteTrack,
  RemoteTrackPublication,
} from 'livekit-client';

// --- Voice Options Data ---
const voiceOptions = [
    { id: 'original', name: 'Original Voice' },
    { id: 'deep-space', name: 'Deep Space' },
    { id: 'synth', name: 'Synth' },
    { id: 'whisper', name: 'Whisper' },
];

// --- Main Page Component ---
export default function RoomPage({ params }: { params: { roomName: string } }) {
  const [isInLobby, setIsInLobby] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  const [selectedVoice, setSelectedVoice] = useState('original');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const [room, setRoom] = useState<Room | undefined>(undefined);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [speakingParticipants, setSpeakingParticipants] = useState<Participant[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.Disconnected);
  
  const audioContainerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const roomName = params.roomName;

  // --- Audio Track Handling ---
  const handleTrackSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: Participant) => {
    if (track.kind === 'audio') {
      const audioElement = track.attach();
      audioContainerRef.current?.appendChild(audioElement);
    }
  };

  const handleTrackUnsubscribed = (track: RemoteTrack) => {
    track.detach().forEach(element => element.remove());
  };


  // --- LiveKit Connection Logic ---
  const handleEnterRoom = async () => {
    const identity = `user-${Math.random().toString(36).substring(7)}`;
    
    try {
      const resp = await fetch(`/api/token?roomName=${roomName}&identity=${identity}`);
      if (!resp.ok) throw new Error('Failed to get access token.');
      const { token } = await resp.json();

      const newRoom = new Room({ adaptiveStream: true, dynacast: true });

      newRoom
        .on(RoomEvent.ConnectionStateChanged, setConnectionState)
        .on(RoomEvent.ParticipantConnected, () => updateParticipants(newRoom))
        .on(RoomEvent.ParticipantDisconnected, () => updateParticipants(newRoom))
        .on(RoomEvent.ActiveSpeakersChanged, setSpeakingParticipants)
        .on(RoomEvent.TrackSubscribed, handleTrackSubscribed)
        .on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

      const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL!;
      await newRoom.connect(wsUrl, token);
      
      await newRoom.localParticipant.setMicrophoneEnabled(!isMuted);
      
      setRoom(newRoom);
      updateParticipants(newRoom);
      setIsInLobby(false);

    } catch (error) {
      console.error("Error connecting to LiveKit:", error);
      alert("Failed to connect to the room. Please check credentials and try again.");
    }
  };
  
  const handleLeaveRoom = useCallback(() => {
    room?.disconnect();
    router.push('/');
  }, [room, router]);

  useEffect(() => {
    return () => { room?.disconnect(); };
  }, [room]);
  
  const updateParticipants = (currentRoom: Room) => {
    setParticipants([currentRoom.localParticipant, ...currentRoom.remoteParticipants.values()]);
  };

  const toggleMute = () => {
    const newMutedState = !isMuted;
    setIsMuted(newMutedState);
    room?.localParticipant.setMicrophoneEnabled(!newMutedState);
  };

  // --- Render Logic ---
  return (
    <>
      {/* This div will hold the invisible audio elements */}
      <div ref={audioContainerRef} /> 
      
      {isInLobby ? (
        <Lobby
          roomName={roomName}
          isConnecting={connectionState === ConnectionState.Connecting}
          isMuted={isMuted}
          toggleMute={toggleMute}
          selectedVoice={selectedVoice}
          setSelectedVoice={setSelectedVoice}
          onEnterRoom={handleEnterRoom}
        />
      ) : (
        <InCall
            participants={participants}
            speakingParticipants={speakingParticipants}
            localParticipantSid={room?.localParticipant.sid}
            isMuted={isMuted}
            toggleMute={toggleMute}
            onLeaveRoom={handleLeaveRoom}
            onToggleSettings={() => setIsSettingsOpen(!isSettingsOpen)}
            isSettingsOpen={isSettingsOpen}
            selectedVoice={selectedVoice}
            setSelectedVoice={setSelectedVoice}
        />
      )}
    </>
  );
}


// --- UI Components (Same as before, no changes needed below this line) ---

function Lobby({ roomName, isConnecting, isMuted, toggleMute, selectedVoice, setSelectedVoice, onEnterRoom }: any) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

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
            <button onClick={onEnterRoom} disabled={isConnecting} className="btn-primary w-full font-bold py-4 rounded-xl text-lg disabled:opacity-50 disabled:cursor-not-allowed">
              {isConnecting ? 'Connecting...' : 'Enter Anonymous Room'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InCall({ participants, speakingParticipants, localParticipantSid, isMuted, toggleMute, onLeaveRoom, onToggleSettings, isSettingsOpen, selectedVoice, setSelectedVoice }: any) {
    return (
        <div className="min-h-screen p-4 md:p-8 flex flex-col items-center justify-center">
            {isSettingsOpen && (
                <SettingsModal 
                    onClose={onToggleSettings}
                    selectedVoice={selectedVoice}
                    setSelectedVoice={setSelectedVoice}
                />
            )}
            <div className="w-full max-w-2xl text-center">
                <h2 className="text-3xl font-bold mb-8">In Conversation</h2>
                <div className="space-y-4">
                    {participants.length > 0 ? participants.map((p: Participant) => {
                        const isSpeaking = speakingParticipants.some((sp: Participant) => sp.sid === p.sid);
                        const isYou = p.sid === localParticipantSid;
                        return (
                            <div key={p.sid} className={`p-4 rounded-2xl flex items-center justify-between transition-all duration-300 ${isSpeaking ? 'bg-[#1C1C1E] gradient-border-active' : 'bg-[#111] border border-[#222]'}`}>
                                <span className={`font-bold text-lg ${isSpeaking ? 'text-white' : 'text-gray-400'}`}>
                                    {isYou ? 'You' : p.identity} {isSpeaking && !isYou && '(Speaking)'}
                                </span>
                                <div className="text-gray-500">
                                    {isSpeaking ? <SoundOnIcon className="w-6 h-6 text-white" /> : <MicIcon className="w-6 h-6 text-gray-600" />}
                                </div>
                            </div>
                        )
                    }) : <p className="text-gray-500">Connecting to the room...</p>}
                     {participants.length === 1 && <p className="text-gray-500 mt-4">You're the first one here. Share the link to invite others.</p>}
                </div>
            </div>

            <div className="fixed bottom-8 flex justify-center w-full">
                <div className="control-bar flex items-center space-x-3 p-2 rounded-full">
                    <button onClick={toggleMute} className={`control-btn p-3 rounded-full ${!isMuted ? 'active' : ''}`}>
                        {isMuted ? <MicOffIcon className="w-6 h-6" /> : <MicIcon className="w-6 h-6" />}
                    </button>
                    <button onClick={onToggleSettings} className="control-btn p-3 rounded-full">
                        <SettingsIcon className="w-6 h-6" />
                    </button>
                    <button onClick={onLeaveRoom} className="control-btn red p-3 rounded-full">
                        <EndCallIcon className="w-6 h-6" />
                    </button>
                </div>
            </div>
        </div>
    );
}

function VoiceOptions({ selectedVoice, setSelectedVoice }: any) {
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
}

function SettingsModal({ onClose, selectedVoice, setSelectedVoice }: any) {
    return (
        <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex items-center justify-center" onClick={onClose}>
            <div className="bg-[#080808] p-8 rounded-2xl border border-[#222] floating-glow w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-semibold mb-4">Change Voice Effect</h3>
                <VoiceOptions selectedVoice={selectedVoice} setSelectedVoice={setSelectedVoice} />
                <button onClick={onClose} className="btn-secondary w-full mt-6 py-2 rounded-lg">Close</button>
            </div>
        </div>
    )
}

// --- SVG Icons ---
const MicIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"></path> </svg> );
const MicOffIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.55-.9L19.73 21 21 19.73 4.27 3z"></path> </svg> );
const EndCallIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.21-3.73-6.56-6.56l1.97-1.57c.27-.27.36-.66.24-1.01-.37-1.11-.56-2.3-.56-3.53c0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99c0 8.27 6.73 15 15 15c.75 0 .99-.65.99-1.19v-2.42c0-.54-.45-.99-.99-.99z"></path> </svg> );
const SettingsIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61-.25-1.17-.59-1.69-.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24-.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59-1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"></path> </svg> );
const CopyIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path> </svg> );
const CheckIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path> </svg> );
const SoundOnIcon = (props: SVGProps<SVGSVGElement>) => ( <svg fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}> <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"></path> </svg> );
