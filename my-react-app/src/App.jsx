import React, { useState, useEffect, useRef } from 'react';
import * as signalR from '@microsoft/signalr';
import { Send, Users, LogOut, Smile, Check, CheckCheck } from 'lucide-react';

const ChatApp = () => {
  const [username, setUsername] = useState('');
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [connection, setConnection] = useState(null);
  const [typingUsers, setTypingUsers] = useState([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(null);
  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const emojiPickerRef = useRef(null);

  const emojis = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👏', '🔥'];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Close emoji picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target)) {
        setShowEmojiPicker(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Mark messages as seen when they appear in viewport
  useEffect(() => {
    if (!connection || messages.length === 0) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const messageId = entry.target.dataset.messageId;
          const messageUser = entry.target.dataset.messageUser;
          
          if (messageId && messageUser && messageUser !== username) {
            // This is the "seen" logic
            connection.invoke('MarkMessageAsSeen', messageId, username).catch(err => console.error(err));
          }
        }
      });
    }, { threshold: 0.5 });

    const messageElements = document.querySelectorAll('[data-message-id]');
    messageElements.forEach(el => observer.observe(el));

    return () => observer.disconnect();
  }, [messages, connection, username]);

  const connectToHub = async (user) => {
    setIsConnecting(true);
    try {
      const newConnection = new signalR.HubConnectionBuilder()
        .withUrl(`https://localhost:7245/chatHub?username=${encodeURIComponent(user)}`)
        .withAutomaticReconnect()
        .build();

      newConnection.on('ReceiveMessage', (fromUser, msg, messageId) => {
        setMessages(prev => [...prev, {
          id: messageId || Date.now().toString() + Math.random(),
          user: fromUser,
          text: msg,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          reactions: {},
          seenBy: [],
          isSent: true
        }]);
      });

      newConnection.on('NotifyNewUser', (newUser) => {
        setMessages(prev => [...prev, {
          id: Date.now().toString(),
          user: 'System',
          text: `${newUser} joined the chat`,
          isSystem: true,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          reactions: {},
          seenBy: []
        }]);
        fetchConnectedUsers();
      });

      newConnection.on('UserTyping', (typingUser) => {
        setTypingUsers(prev => {
          if (!prev.includes(typingUser)) {
            return [...prev, typingUser];
          }
          return prev;
        });
      });

      newConnection.on('UserStoppedTyping', (stoppedUser) => {
        setTypingUsers(prev => prev.filter(u => u !== stoppedUser));
      });

      // This handles receiving reactions from other users
      newConnection.on('ReceiveReaction', (messageId, fromUser, emoji) => {
        setMessages(prev => prev.map(msg => {
          if (msg.id === messageId) {
            const newReactions = { ...(msg.reactions || {}) };
            if (emoji === null || emoji === '') {
              delete newReactions[fromUser];
            } else {
              newReactions[fromUser] = emoji;
            }
            return { ...msg, reactions: newReactions };
          }
          return msg;
        }));
      });

      // This is the client-side part of the "blue tick"
      newConnection.on('MessageSeen', (messageId, seenByUser) => {
        setMessages(prev => prev.map(msg => {
          if (msg.id === messageId) {
            const currentSeenBy = Array.isArray(msg.seenBy) ? msg.seenBy : [];
            if (!currentSeenBy.includes(seenByUser)) {
              return { ...msg, seenBy: [...currentSeenBy, seenByUser] };
            }
          }
          return msg;
        }));
      });

      await newConnection.start();
      setConnection(newConnection);
      await fetchConnectedUsers();
      setIsConnecting(false);
    } catch (err) {
      console.error('Failed to connect:', err);
      alert('Failed to connect to chat server. Please check if the server is running.');
      setIsConnecting(false);
    }
  };

  const fetchConnectedUsers = async () => {
    try {
      const res = await fetch('https://localhost:7245/api/Chat/users');
      const users = await res.json();
      setConnectedUsers(users);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    }
  };

  const handleLogin = () => {
    if (username.trim()) {
      connectToHub(username);
      setIsLoggedIn(true);
    }
  };

  const handleSendMessage = async () => {
    if (!message.trim() || !connection) return;
    
    // Create a unique ID on the client
    const messageId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
    
    try {
      // Send the message and ID to the hub
      await connection.invoke('SendMessage', username, message, messageId);
      
      // Optimistic update: Add message to sender's UI immediately
      setMessages(prev => [...prev, {
        id: messageId,
        user: username,
        text: message,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        reactions: {},
        seenBy: [],
        isSent: true // 'isSent' marks it for the double-grey-tick
      }]);
      setMessage('');
      handleStopTyping();
    } catch (err) {
      console.error('Send failed:', err);
      // You could add logic here to mark the message as 'failed'
    }
  };

  const handleTyping = () => {
    if (connection && username) {
      connection.invoke('Typing', username).catch(err => console.error(err));
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => handleStopTyping(), 2000);
    }
  };

  const handleStopTyping = () => {
    if (connection && username) {
      connection.invoke('StoppedTyping', username).catch(err => console.error(err));
    }
  };

  const handleReaction = async (messageId, emoji) => {
    if (!connection) return;
    
    const msg = messages.find(m => m.id === messageId);
    const currentReaction = msg?.reactions?.[username];
    
    // If clicking the same emoji, remove it (toggle)
    const newEmoji = currentReaction === emoji ? null : emoji;
    
    try {
      // Send reaction to the hub
      await connection.invoke('ReactToMessage', messageId, username, newEmoji);
      
      // Optimistic update for the sender
      setMessages(prev => prev.map(m => {
        if (m.id === messageId) {
          const newReactions = { ...(m.reactions || {}) };
          if (newEmoji === null) {
            delete newReactions[username];
          } else {
            newReactions[username] = newEmoji;
          }
          return { ...m, reactions: newReactions };
        }
        return m;
      }));
    } catch (err) {
      console.error('Reaction failed:', err);
    }
    
    setShowEmojiPicker(null);
  };

  const handleDisconnect = async () => {
    if (connection) {
      await connection.stop();
    }
    setIsLoggedIn(false);
    setUsername('');
    setMessages([]);
    setConnectedUsers([]);
    setTypingUsers([]);
  };

  // This function IS the "blue tick" logic
  const getReadReceiptIcon = (msg) => {
    if (msg.user !== username || msg.isSystem) return null;
    
    // Check if message has been seen by any *other* user
    const seenByArray = Array.isArray(msg.seenBy) ? msg.seenBy : [];
    const seenByOthers = seenByArray.filter(u => u !== username).length > 0;
    
    if (seenByOthers) {
      // Seen by recipient: Double BLUE tick
      return <CheckCheck size={14} className="read-receipt blue" />;
    } else if (msg.isSent) {
      // Sent but not seen: Double GREY tick
      return <CheckCheck size={14} className="read-receipt" />;
    } else {
      // Sending (or failed): Single GREY tick
      return <Check size={14} className="read-receipt" />;
    }
  };

  // Modern Login Screen
  if (!isLoggedIn) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-header">
            <div className="logo-circle">💬</div>
            <h1 className="login-title">Welcome to ChatApp</h1>
            <p className="login-subtitle">Connect with your team instantly</p>
          </div>
          <input
            type="text"
            placeholder="Enter your username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
            className="login-input"
            disabled={isConnecting}
          />
          <button 
            onClick={handleLogin} 
            className="login-button"
            disabled={isConnecting || !username.trim()}
          >
            {isConnecting ? 'Connecting...' : 'Join Chat'}
          </button>
        </div>
      </div>
    );
  }

  // Main Chat UI
  return (
    <div className="chat-container">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <div className="header-icon"></div>
          <div>
            <h2 className="header-title">SignalR ChatApp</h2>
            <p className="header-subtitle">Logged in as <strong>{username}</strong></p>
          </div>
        </div>
        <button onClick={handleDisconnect} className="logout-button">
          <LogOut size={16} />
          <span>Logout</span>
        </button>
      </div>

      <div className="chat-body">
        {/* Main Chat Area */}
        <div className="chat-area">
          <div className="messages-container">
            {messages.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">💭</div>
                <p className="empty-text">No messages yet. Start the conversation!</p>
              </div>
            ) : (
              messages.map(msg => (
                <div
                  key={msg.id}
                  className="message-wrapper"
                  data-message-id={msg.id} // Used by IntersectionObserver
                  data-message-user={msg.user} // Used by IntersectionObserver
                  style={{
                    justifyContent: msg.isSystem ? 'center' : mxsg.user === username ? 'flex-end' : 'flex-start'
                  }}
                >
                  {msg.isSystem ? (
                    <div className="system-message">{msg.text}</div>
                  ) : (
                    <div className="message-bubble-container">
                      <div className={msg.user === username ? 'own-message' : 'other-message'}>
                        <div className="message-header">
                          <span className="message-user">{msg.user}</span>
                          <span className="message-time">{msg.timestamp}</span>
                        </div>
                        <div className="message-text">{msg.text}</div>
                        <div className="message-footer">
                          {getReadReceiptIcon(msg)}
                        </div>
                      </div>
                      
                      {/* Reactions Display: Aggregates multiple reactions */}
                      {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                        <div className={`reactions-display ${msg.user === username ? 'own' : ''}`}>
                          {Object.entries(
                            Object.values(msg.reactions).reduce((acc, emoji) => {
                              acc[emoji] = (acc[emoji] || 0) + 1;
                              return acc;
                            }, {})
                          ).map(([emoji, count]) => (
                            <span key={emoji} className="reaction-count">
                              {emoji} {count > 1 && count}
                            </span>
                          ))}
                        </div>
                      )}
                      
                      {/* Reaction Button */}
                      <button 
                        className={`reaction-btn ${msg.user === username ? 'own' : ''}`}
                        onClick={() => setShowEmojiPicker(showEmojiPicker === msg.id ? null : msg.id)}
                      >
                        <Smile size={16} />
                      </button>
                      
                      {/* Emoji Picker */}
                      {showEmojiPicker === msg.id && (
                        <div 
                          ref={emojiPickerRef}
                          className={`emoji-picker ${msg.user === username ? 'own' : ''}`}
                        >
                          {emojis.map(emoji => (
                            <button
                              key={emoji}
                              className="emoji-btn"
                              onClick={() => handleReaction(msg.id, emoji)}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Typing Indicator */}
          {typingUsers.length > 0 && (
            <div className="typing-indicator">
              <div className="typing-dots">
                <span className="dot"></span>
                <span className="dot"></span>
                <span className="dot"></span>
              </div>
              <span>{typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing</span>
            </div>
          )}

          {/* Input Area */}
          <div className="input-area">
            <input
              type="text"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                handleTyping();
              }}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Type your message..."
              className="message-input"
            />
            <button onClick={handleSendMessage} className="send-button">
              <Send size={20} />
            </button>
          </div>
        </div>

        {/* Sidebar (for responsiveness) */}
        <div className="sidebar">
          <div className="sidebar-header">
            <Users size={20} />
            <span className="sidebar-title">Online ({connectedUsers.length})</span>
          </div>
          <div className="users-list">
            {connectedUsers.map((user, idx) => (
              <div key={idx} className="user-item">
                <div className="avatar-circle">
                  {user.charAt(0).toUpperCase()}
                </div>
                <span className="user-name">{user}</span>
                <div className="online-indicator"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatApp;