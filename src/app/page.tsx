"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const [roomCode, setRoomCode] = useState('');
  const router = useRouter();

  const createRoom = () => {
    const newRoomCode = 'veil-' + Math.random().toString(36).substring(2, 5) + '-' + Math.random().toString(36).substring(2, 5);
    router.push(`/room/${newRoomCode}`);
  };

  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomCode) {
      router.push(`/room/${roomCode}`);
    }
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen p-4 text-center antialiased">
      <div className="max-w-4xl">
        <h1 className="text-5xl md:text-7xl font-black gradient-text leading-tight">
          Anonymous Conversations, Uncompromised Clarity.
        </h1>
        <p className="mt-6 text-lg md:text-xl text-gray-400 max-w-2xl mx-auto">
          No accounts. No tracking. Just secure voice calls with real-time voice transformation.
        </p>
      </div>
      <div className="mt-12 space-y-4">
        <button onClick={createRoom} className="btn-primary font-bold py-4 px-10 rounded-xl text-lg w-full sm:w-auto">
          Create Anonymous Room
        </button>
        <form onSubmit={joinRoom} className="flex flex-col sm:flex-row items-center justify-center space-y-4 sm:space-y-0 sm:space-x-2 pt-4">
          <input
            type="text"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            placeholder="Enter Room Code"
            className="input-field rounded-xl px-4 py-3 text-white w-full sm:w-64"
          />
          <button type="submit" className="btn-secondary font-semibold py-3 px-8 rounded-xl w-full sm:w-auto">
            Join
          </button>
        </form>
      </div>
    </main>
  );
}
