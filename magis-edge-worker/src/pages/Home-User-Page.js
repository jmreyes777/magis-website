import React, { useState } from 'react';
import Header from '../components/Header-User-Component';
import Footer from '../components/Footer-User-Component';
import GuestChatBox from '../components/Guest-Chat-Box-Component'; // Ensure GuestChatBox is imported

function Home() {
  const [activeChat, setActiveChat] = useState(null); // Manage chat widget state

  const handleStartChat = (branchEmail, branchName) => {
    setActiveChat({ branchEmail, branchName }); // Initialize chat widget with branch details
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header Section */}
      <Header />

      {/* Main Content */}
      <main className="flex-grow p-6 text-center">
        <h1 className="text-4xl font-bold mb-6 text-yellow-600">
          Welcome to Magis Project
        </h1>
        <p className="text-lg text-gray-700 mb-8">
          Explore our services and chat with us for more details.
        </p>

        {/* Example Service Section */}
        <div className="services">
          <button
            onClick={() => handleStartChat('info@magisgold.com', 'Magis Branch')}
            className="px-6 py-3 bg-yellow-500 text-white rounded-lg shadow hover:bg-yellow-600 transition duration-300"
          >
            Start Chat with Magis Branch
          </button>
        </div>

        {/* Chat Widget */}
        {activeChat && (
          <div className="chat-widget mt-8 bg-white p-4 rounded-lg shadow-md">
            <p className="text-lg font-semibold">
              Chatting with {activeChat.branchName} ({activeChat.branchEmail})
            </p>
            <button
              onClick={() => setActiveChat(null)}
              className="mt-4 px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition duration-300"
            >
              Close Chat
            </button>
            <GuestChatBox branchEmail={activeChat.branchEmail} />
          </div>
        )}
      </main>

      {/* Footer Section */}
      <Footer />
    </div>
  );
}

export default Home;