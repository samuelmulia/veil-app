"use client";

// This is a simplified example. A full implementation would require more robust state management
// and handling of all LiveKit events.
// Note: Web Audio API for voice effects is not implemented here but this is where it would go.

import { useEffect, useState } from 'react';
import { Room, RoomEvent, Participant, RemoteParticipant } from 'livekit-client';

export default function RoomPage({ params }: { params: { roomName: string } }) {
  const [isInLobby, setIsInLobby] = useState(true);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [speakingParticipant, setSpeakingParticipant] = useState<string | null>(null);

  const roomName = params.roomName;

  useEffect(() => {
    // This is where you would connect to LiveKit after the user clicks "Enter Room"
    // For this mockup, we'll just simulate the UI change.
  }, []);
  
  const enterRoom = async () => {
    // In a real app:
    // 1. Fetch token from your /api/token route
    // 2. Create new Room object: const room = new Room(...)
    // 3. Set up listeners for RoomEvent.ParticipantConnected, etc.
    // 4. Connect to the room: await room.connect(wsUrl, token)
    // 5. Publish local tracks (microphone with voice effect)
    setIsInLobby(false);
    
    // Mock participants for UI demonstration
    setParticipants([
        { identity: 'You', sid: 'you-sid' } as Participant,
        { identity: 'Participant 2', sid: 'p2-sid' } as Participant
    ]);
    
    // Simulate speaking
    setTimeout(() => setSpeakingParticipant('p2-sid'), 2000);
  };
  
  if (isInLobby) {
    // Lobby UI
    return (
        <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
            {/* The Lobby component from the mockup would go here */}
            {/* I've simplified it to a single "Enter Room" button for brevity */}
            <div className="text-center">
                <h1 className="text-3xl font-bold mb-4">Room: {roomName}</h1>
                <p className="text-gray-400 mb-8">Configure your voice and join the call.</p>
                <button onClick={enterRoom} className="btn-primary font-bold py-4 px-10 rounded-xl text-lg">
                    Enter Room
                </button>
            </div>
        </div>
    );
  }

  // In-Call UI
  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-2xl text-center">
         <h2 className="text-3xl font-bold mb-8">In Conversation</h2>
         <div className="space-y-4">
            {participants.map(p => (
                <div key={p.sid} className={`p-4 rounded-2xl flex items-center justify-between ${speakingParticipant === p.sid ? 'bg-[#1C1C1E] gradient-border-active' : 'bg-[#111] border border-[#222]'}`}>
                    <span className={`font-bold text-lg ${speakingParticipant === p.sid ? '' : 'text-gray-400'}`}>
                        {p.identity} {speakingParticipant === p.sid && '(Speaking)'}
                    </span>
                    {/* Add icons here */}
                </div>
            ))}
         </div>
      </div>
      {/* Control Bar would go here */}
    </div>
  );
}
