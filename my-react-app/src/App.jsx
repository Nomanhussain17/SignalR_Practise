import React, { useState, useEffect, useRef, useCallback } from "react";
import * as signalR from "@microsoft/signalr";
import {
  Send,
  Users,
  LogOut,
  Smile,
  Check,
  CheckCheck,
  Bell,
} from "lucide-react";

const ChatApp = () => {
  const [username, setUsername] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [connection, setConnection] = useState(null);
  const [typingUsers, setTypingUsers] = useState([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [showEmojiPicker, setShowEmojiPicker] = useState(null);
  const [hasNewNotification, setHasNewNotification] = useState(false);

  const typingTimeoutRef = useRef(null);
  const messagesEndRef = useRef(null);
  const emojiPickerRef = useRef(null);
  const pingIntervalRef = useRef(null);
  const seenMessagesRef = useRef(new Set());
  const isConnectedRef = useRef(false);

  const emojis = ["👍", "❤️", "😂", "😮", "😢", "🙏", "👏", "🔥"];

  const USERNAME_STORAGE_KEY = "chatAppUsername";
  const SESSION_ID_KEY = "browserSessionId";

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(event.target)
      ) {
        setShowEmojiPicker(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!connection || messages.length === 0 || !isLoggedIn) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const messageId = entry.target.dataset.messageId;
            const messageUser = entry.target.dataset.messageUser;

            if (
              messageId &&
              messageUser &&
              messageUser !== username &&
              !seenMessagesRef.current.has(messageId)
            ) {
              seenMessagesRef.current.add(messageId);
              connection
                .invoke("MarkMessageAsSeen", messageId, username)
                .catch((err) =>
                  console.error("Failed to mark message as seen:", err)
                );
            }
          }
        });
      },
      { threshold: 0.5 }
    );

    const messageElements = document.querySelectorAll("[data-message-id]");
    messageElements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [messages, connection, username, isLoggedIn]);

  const connectToHub = useCallback(async (user) => {
    if (isConnectedRef.current) {
      console.log("Already connected, skipping duplicate connection");
      return null;
    }

    isConnectedRef.current = true;

    setIsConnecting(true);
    setConnectionStatus("connecting");

    if (Notification.permission === "default") {
      Notification.requestPermission();
    }

    try {
      let browserSessionId = localStorage.getItem(SESSION_ID_KEY);
      if (!browserSessionId) {
        browserSessionId = crypto.randomUUID();
        localStorage.setItem(SESSION_ID_KEY, browserSessionId);
      }

      const deviceType = /Mobi|Android|iPhone/i.test(navigator.userAgent)
        ? "mobile"
        : "web";

      const newConnection = new signalR.HubConnectionBuilder()
        .withUrl(
          `https://localhost:7245/chatHub?username=${encodeURIComponent(
            user
          )}&deviceType=${deviceType}&sessionId=${encodeURIComponent(
            browserSessionId
          )}`
        )
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: (retryContext) => {
            if (retryContext.elapsedMilliseconds < 60000) {
              return Math.min(
                1000 * Math.pow(2, retryContext.previousRetryCount),
                30000
              );
            }
            return null;
          },
        })
        .configureLogging(signalR.LogLevel.Information)
        .build();

      newConnection.onreconnecting(() => {
        setConnectionStatus("reconnecting");
        console.log("Reconnecting...");
      });

      newConnection.onreconnected(() => {
        setConnectionStatus("connected");
        console.log("Reconnected successfully");
      });

      newConnection.onclose((error) => {
        setConnectionStatus("disconnected");
        isConnectedRef.current = false;
        if (error) {
          console.error("Connection closed with error:", error);
        }
      });

      // Always setup listeners for new connection
      newConnection.on("ReceiveMessage", (fromUser, msg, messageId) => {
          setMessages((prev) => {
            if (prev.some((m) => m.id === messageId)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: messageId,
                user: fromUser,
                text: msg,
                timestamp: new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
                reactions: {},
                seenBy: [],
                isSent: true,
              },
            ];
          });
        });

        newConnection.on(
          "ReceiveNotification",
          (fromUser, message, messageId) => {
            setHasNewNotification(true);

            if (document.hidden && Notification.permission === "granted") {
              new Notification("New Message", {
                body: `${fromUser}: ${message.substring(0, 50)}${
                  message.length > 50 ? "..." : ""
                }`,
              });
            }
          }
        );

        newConnection.on("NotifyNewUser", (newUser) => {
          setMessages((prev) => [
            ...prev,
            {
              id: `system-${Date.now()}-${Math.random()}`,
              user: "System",
              text: `${newUser} joined the chat`,
              isSystem: true,
              timestamp: new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
              reactions: {},
              seenBy: [],
            },
          ]);
        });

        newConnection.on("UserTyping", (typingUser) => {
          setTypingUsers((prev) => {
            if (prev.includes(typingUser)) {
              return prev;
            }
            return [...prev, typingUser];
          });
        });

        newConnection.on("UserStoppedTyping", (stoppedUser) => {
          setTypingUsers((prev) => prev.filter((u) => u !== stoppedUser));
        });

        newConnection.on("ReceiveReaction", (messageId, fromUser, emoji) => {
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === messageId) {
                const newReactions = { ...(msg.reactions || {}) };
                if (emoji === null || emoji === "") {
                  delete newReactions[fromUser];
                } else {
                  newReactions[fromUser] = emoji;
                }
                return { ...msg, reactions: newReactions };
              }
              return msg;
            })
          );
        });

        newConnection.on("MessageSeen", (messageId, seenByUser) => {
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === messageId) {
                const currentSeenBy = Array.isArray(msg.seenBy)
                  ? msg.seenBy
                  : [];
                if (!currentSeenBy.includes(seenByUser)) {
                  return { ...msg, seenBy: [...currentSeenBy, seenByUser] };
                }
              }
              return msg;
            })
          );
        });

        newConnection.on("updateuserlist", (users) => {
          console.log("User list updated:", users);
          setConnectedUsers(
            users.map((username) => ({
              username: username,
              connectionId: username,
            }))
          );
        });

      await newConnection.start();
      setConnection(newConnection);
      setConnectionStatus("connected");
      setIsConnecting(false);
      // isConnectedRef.current = true;

      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
      }

      pingIntervalRef.current = setInterval(() => {
        if (newConnection.state === signalR.HubConnectionState.Connected) {
          newConnection
            .invoke("Ping")
            .catch((err) => console.error("Ping failed:", err));
        }
      }, 30000);

        return newConnection;
      } catch (err) {
        console.error("Failed to connect:", err);
        setConnectionStatus("disconnected");
        setIsConnecting(false);
        isConnectedRef.current = false;
        alert(
          "Failed to connect to chat server. Please check if the server is running on https://localhost:7245"
        );
        return null;
      }
    }, []);

  useEffect(() => {
    const storedUsername = localStorage.getItem(USERNAME_STORAGE_KEY);
    if (storedUsername && !isConnectedRef.current) {
      setUsername(storedUsername);
      setIsLoggedIn(true);
      connectToHub(storedUsername);
    }
  }, [connectToHub]);

  const handleLogin = async () => {
    if (username.trim() && !isConnectedRef.current) {
      const trimmedUsername = username.trim();
      localStorage.setItem(USERNAME_STORAGE_KEY, trimmedUsername);
      await connectToHub(trimmedUsername);
      setIsLoggedIn(true);
    }
  };

  const handleBellClick = () => {
    setHasNewNotification(false);
    window.focus();
    scrollToBottom();
  };

  const handleSendMessage = async () => {
    if (!message.trim() || !connection) return;

    if (connection.state !== signalR.HubConnectionState.Connected) {
      alert("Not connected to server. Please wait for reconnection.");
      return;
    }

    const messageId = `${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    const messageText = message.trim();

    try {
      setMessages((prev) => {
        if (prev.some((m) => m.id === messageId)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: messageId,
            user: username,
            text: messageText,
            timestamp: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            reactions: {},
            seenBy: [],
            isSent: true,
          },
        ];
      });

      setMessage("");
      handleStopTyping();

      await connection.invoke("SendMessage", username, messageText, messageId);
    } catch (err) {
      console.error("Send failed:", err);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId ? { ...msg, isSent: false, failed: true } : msg
        )
      );
    }
  };

  const handleTyping = () => {
    if (
      connection &&
      username &&
      connection.state === signalR.HubConnectionState.Connected
    ) {
      connection
        .invoke("Typing", username)
        .catch((err) => console.error("Typing notification failed:", err));

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => handleStopTyping(), 2000);
    }
  };

  const handleStopTyping = () => {
    if (
      connection &&
      username &&
      connection.state === signalR.HubConnectionState.Connected
    ) {
      connection
        .invoke("StoppedTyping", username)
        .catch((err) => console.error("Stop typing notification failed:", err));
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  };

  const handleReaction = async (messageId, emoji) => {
    if (
      !connection ||
      connection.state !== signalR.HubConnectionState.Connected
    )
      return;

    const msg = messages.find((m) => m.id === messageId);
    const currentReaction = msg?.reactions?.[username];

    const newEmoji = currentReaction === emoji ? "" : emoji;

    try {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === messageId) {
            const newReactions = { ...(m.reactions || {}) };
            if (newEmoji === "") {
              delete newReactions[username];
            } else {
              newReactions[username] = newEmoji;
            }
            return { ...m, reactions: newReactions };
          }
          return m;
        })
      );

      await connection.invoke("ReactToMessage", messageId, username, newEmoji);
    } catch (err) {
      console.error("Reaction failed:", err);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === messageId) {
            const revertReactions = { ...(m.reactions || {}) };
            if (currentReaction) {
              revertReactions[username] = currentReaction;
            } else {
              delete revertReactions[username];
            }
            return { ...m, reactions: revertReactions };
          }
          return m;
        })
      );
    }

    setShowEmojiPicker(null);
  };

  const handleDisconnect = async () => {
    try {
      console.log("Starting logout process...");
      
      // Stop all timers first
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      // Notify server about explicit logout BEFORE stopping connection
      if (connection && connection.state === signalR.HubConnectionState.Connected) {
        try {
          await connection.invoke("ExplicitLogout", username);
          console.log("Sent explicit logout notification to server");
        } catch (logoutError) {
          console.error("Error sending logout notification:", logoutError);
        }
      }

      // Clear stored username AFTER notifying server
      localStorage.removeItem(USERNAME_STORAGE_KEY);

      // Stop the connection
      if (connection) {
        try {
          if (
            connection.state === signalR.HubConnectionState.Connected ||
            connection.state === signalR.HubConnectionState.Connecting ||
            connection.state === signalR.HubConnectionState.Reconnecting
          ) {
            await connection.stop();
            console.log("Connection stopped successfully");
          }
        } catch (stopError) {
          console.error("Error stopping connection:", stopError);
        }
      }

      // Reset all state
      setConnection(null);
      setIsLoggedIn(false);
      setHasNewNotification(false);
      setUsername("");
      setMessages([]);
      setConnectedUsers([]);
      setTypingUsers([]);
      setConnectionStatus("disconnected");
      seenMessagesRef.current.clear();
      isConnectedRef.current = false;
      // hasSetupListenersRef removed - no longer needed

      console.log("Logout completed successfully");
    } catch (err) {
      console.error("Error during disconnect:", err);
      // Force reset even on error
      localStorage.removeItem(USERNAME_STORAGE_KEY);
      setConnection(null);
      setIsLoggedIn(false);
      isConnectedRef.current = false;
      // hasSetupListenersRef removed - no longer needed
    }
  };

  const getReadReceiptIcon = (msg) => {
    if (msg.user !== username || msg.isSystem) return null;

    if (msg.failed) {
      return (
        <span className="read-receipt failed" title="Failed to send">
          !
        </span>
      );
    }

    const seenByArray = Array.isArray(msg.seenBy) ? msg.seenBy : [];
    const seenByOthers = seenByArray.filter((u) => u !== username).length > 0;

    if (seenByOthers) {
      return (
        <CheckCheck size={14} className="read-receipt blue" title="Seen" />
      );
    } else if (msg.isSent) {
      return (
        <CheckCheck size={14} className="read-receipt grey" title="Delivered" />
      );
    } else {
      return <Check size={14} className="read-receipt grey" title="Sending" />;
    }
  };

  const getConnectionStatusBadge = () => {
    const statusConfig = {
      connected: { color: "#10b981", text: "Connected" },
      connecting: { color: "#f59e0b", text: "Connecting..." },
      reconnecting: { color: "#f59e0b", text: "Reconnecting..." },
      disconnected: { color: "#ef4444", text: "Disconnected" },
    };

    const config = statusConfig[connectionStatus] || statusConfig.disconnected;

    return (
      <div
        className="connection-status"
        style={{ display: "flex", alignItems: "center", gap: "6px" }}
      >
        <div
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor: config.color,
          }}
        />
        <span style={{ fontSize: "12px", color: "#6b7280" }}>
          {config.text}
        </span>
      </div>
    );
  };

  if (!isLoggedIn) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
          padding: "20px",
        }}
      >
        <div
          style={{
            backgroundColor: "white",
            borderRadius: "16px",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
            padding: "48px",
            width: "100%",
            maxWidth: "420px",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: "32px" }}>
            <div
              style={{
                width: "80px",
                height: "80px",
                margin: "0 auto 20px",
                background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "36px",
              }}
            >
              💬
            </div>
            <h1
              style={{
                fontSize: "28px",
                fontWeight: "700",
                color: "#1f2937",
                marginBottom: "8px",
              }}
            >
              Welcome to ChatApp
            </h1>
            <p
              style={{
                fontSize: "14px",
                color: "#6b7280",
              }}
            >
              Connect with your team instantly
            </p>
          </div>
          <input
            type="text"
            placeholder="Enter your username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyPress={(e) =>
              e.key === "Enter" && !isConnecting && handleLogin()
            }
            disabled={isConnecting}
            style={{
              width: "100%",
              padding: "14px 16px",
              fontSize: "15px",
              border: "2px solid #e5e7eb",
              borderRadius: "8px",
              marginBottom: "16px",
              outline: "none",
              transition: "border-color 0.2s",
              boxSizing: "border-box",
            }}
            onFocus={(e) => (e.target.style.borderColor = "#667eea")}
            onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
          />
          <button
            onClick={handleLogin}
            disabled={isConnecting || !username.trim()}
            style={{
              width: "100%",
              padding: "14px",
              fontSize: "16px",
              fontWeight: "600",
              color: "white",
              background:
                username.trim() && !isConnecting
                  ? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
                  : "#d1d5db",
              border: "none",
              borderRadius: "8px",
              cursor:
                username.trim() && !isConnecting ? "pointer" : "not-allowed",
              transition: "transform 0.2s",
            }}
            onMouseEnter={(e) => {
              if (username.trim() && !isConnecting) {
                e.target.style.transform = "translateY(-2px)";
              }
            }}
            onMouseLeave={(e) => (e.target.style.transform = "translateY(0)")}
          >
            {isConnecting ? "Connecting..." : "Join Chat"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        backgroundColor: "#f3f4f6",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          backgroundColor: "white",
          borderBottom: "1px solid #e5e7eb",
          padding: "16px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div
            style={{
              width: "40px",
              height: "40px",
              background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              borderRadius: "8px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "20px",
            }}
          >
            💬
          </div>
          <div>
            <h2
              style={{
                fontSize: "18px",
                fontWeight: "700",
                color: "#1f2937",
                margin: 0,
              }}
            >
              SignalR ChatApp
            </h2>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginTop: "2px",
              }}
            >
              <p style={{ fontSize: "13px", color: "#6b7280", margin: 0 }}>
                <strong>{username}</strong>
              </p>
              {getConnectionStatusBadge()}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <button
            onClick={handleBellClick}
            style={{
              position: "relative",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "#6b7280",
              padding: "8px",
            }}
            title="Notifications"
          >
            <Bell size={22} />
            {hasNewNotification && (
              <div
                style={{
                  position: "absolute",
                  top: "4px",
                  right: "4px",
                  width: "10px",
                  height: "10px",
                  backgroundColor: "#10b981",
                  borderRadius: "50%",
                  border: "2px solid white",
                }}
              />
            )}
          </button>

          <button
            onClick={handleDisconnect}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "8px 16px",
              backgroundColor: "#fee2e2",
              color: "#dc2626",
              border: "none",
              borderRadius: "6px",
              fontSize: "14px",
              fontWeight: "500",
              cursor: "pointer",
              transition: "background-color 0.2s",
            }}
            onMouseEnter={(e) => (e.target.style.backgroundColor = "#fecaca")}
            onMouseLeave={(e) => (e.target.style.backgroundColor = "#fee2e2")}
          >
            <LogOut size={16} />
            <span>Logout</span>
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "20px",
              backgroundColor: "#f9fafb",
            }}
          >
            {messages.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  color: "#9ca3af",
                }}
              >
                <div style={{ fontSize: "64px", marginBottom: "16px" }}>💭</div>
                <p style={{ fontSize: "16px" }}>
                  No messages yet. Start the conversation!
                </p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  data-message-id={msg.isSystem ? undefined : msg.id}
                  data-message-user={msg.isSystem ? undefined : msg.user}
                  style={{
                    display: "flex",
                    justifyContent: msg.isSystem
                      ? "center"
                      : msg.user === username
                      ? "flex-end"
                      : "flex-start",
                    marginBottom: "16px",
                  }}
                >
                  {msg.isSystem ? (
                    <div
                      style={{
                        padding: "6px 12px",
                        backgroundColor: "#e5e7eb",
                        color: "#6b7280",
                        borderRadius: "12px",
                        fontSize: "13px",
                      }}
                    >
                      {msg.text}
                    </div>
                  ) : (
                    <div style={{ position: "relative", maxWidth: "70%" }}>
                      <div
                        style={{
                          backgroundColor:
                            msg.user === username ? "#667eea" : "white",
                          color: msg.user === username ? "white" : "#1f2937",
                          padding: "12px 16px",
                          borderRadius: "12px",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginBottom: "4px",
                            fontSize: "12px",
                            opacity: 0.8,
                          }}
                        >
                          <span style={{ fontWeight: "600" }}>{msg.user}</span>
                          <span>{msg.timestamp}</span>
                        </div>
                        <div
                          style={{
                            fontSize: "15px",
                            lineHeight: "1.5",
                            wordBreak: "break-word",
                          }}
                        >
                          {msg.text}
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            marginTop: "4px",
                          }}
                        >
                          {getReadReceiptIcon(msg)}
                        </div>
                      </div>

                      {msg.reactions &&
                        Object.keys(msg.reactions).length > 0 && (
                          <div
                            style={{
                              position: "absolute",
                              bottom: "-8px",
                              [msg.user === username ? "right" : "left"]:
                                "12px",
                              display: "flex",
                              gap: "4px",
                              backgroundColor: "white",
                              padding: "2px 8px",
                              borderRadius: "12px",
                              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
                              fontSize: "12px",
                            }}
                          >
                            {Object.entries(
                              Object.values(msg.reactions).reduce(
                                (acc, emoji) => {
                                  acc[emoji] = (acc[emoji] || 0) + 1;
                                  return acc;
                                },
                                {}
                              )
                            ).map(([emoji, count]) => (
                              <span key={emoji}>
                                {emoji} {count > 1 && count}
                              </span>
                            ))}
                          </div>
                        )}

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowEmojiPicker(
                            showEmojiPicker === msg.id ? null : msg.id
                          );
                        }}
                        style={{
                          position: "absolute",
                          top: "50%",
                          transform: "translateY(-50%)",
                          [msg.user === username ? "left" : "right"]: "-32px",
                          width: "24px",
                          height: "24px",
                          borderRadius: "50%",
                          border: "none",
                          backgroundColor: "#f3f4f6",
                          color: "#6b7280",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          opacity: 0.6,
                          transition: "opacity 0.2s",
                        }}
                        onMouseEnter={(e) => (e.target.style.opacity = 1)}
                        onMouseLeave={(e) => (e.target.style.opacity = 0.6)}
                      >
                        <Smile size={14} />
                      </button>

                      {showEmojiPicker === msg.id && (
                        <div
                          ref={emojiPickerRef}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            position: "absolute",
                            bottom: "-45px",
                            [msg.user === username ? "right" : "left"]: "8px",
                            backgroundColor: "white",
                            borderRadius: "24px",
                            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                            padding: "8px 12px",
                            display: "flex",
                            gap: "4px",
                            zIndex: 10,
                          }}
                        >
                          {emojis.map((emoji) => (
                            <button
                              key={emoji}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleReaction(msg.id, emoji);
                              }}
                              style={{
                                border: "none",
                                background: "none",
                                fontSize: "20px",
                                cursor: "pointer",
                                padding: "4px",
                                borderRadius: "4px",
                                transition: "transform 0.2s",
                              }}
                              onMouseEnter={(e) =>
                                (e.target.style.transform = "scale(1.3)")
                              }
                              onMouseLeave={(e) =>
                                (e.target.style.transform = "scale(1)")
                              }
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

          {typingUsers.length > 0 && (
            <div
              style={{
                padding: "8px 24px",
                backgroundColor: "#f9fafb",
                borderTop: "1px solid #e5e7eb",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                fontSize: "13px",
                color: "#6b7280",
              }}
            >
              <div style={{ display: "flex", gap: "4px" }}>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      backgroundColor: "#6f7275ff",
                      animation: `bounce 1.4s infinite ${i * 0.2}s`,
                    }}
                  />
                ))}
              </div>
              <span>
                {typingUsers.join(", ")}{" "}
                {typingUsers.length === 1 ? "is" : "are"} typing...
              </span>
            </div>
          )}

          <div
            style={{
              padding: "16px 24px",
              backgroundColor: "white",
              borderTop: "1px solid #e5e7eb",
              display: "flex",
              gap: "12px",
            }}
          >
            <input
              type="text"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                handleTyping();
              }}
              onKeyPress={(e) => e.key === "Enter" && handleSendMessage()}
              placeholder="Type your message..."
              disabled={connectionStatus !== "connected"}
              style={{
                flex: 1,
                padding: "12px 16px",
                fontSize: "15px",
                border: "1px solid #e5e7eb",
                borderRadius: "24px",
                outline: "none",
                backgroundColor:
                  connectionStatus === "connected" ? "white" : "#f3f4f6",
              }}
              onFocus={(e) => (e.target.style.borderColor = "#667eea")}
              onBlur={(e) => (e.target.style.borderColor = "#e5e7eb")}
            />
            <button
              onClick={handleSendMessage}
              disabled={!message.trim() || connectionStatus !== "connected"}
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "50%",
                border: "none",
                background:
                  message.trim() && connectionStatus === "connected"
                    ? "linear-gradient(135deg, #667eea 0%, #764ba2 100%)"
                    : "#d1d5db",
                color: "white",
                cursor:
                  message.trim() && connectionStatus === "connected"
                    ? "pointer"
                    : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "transform 0.2s",
              }}
              onMouseEnter={(e) => {
                if (message.trim() && connectionStatus === "connected") {
                  e.target.style.transform = "scale(1.1)";
                }
              }}
              onMouseLeave={(e) => (e.target.style.transform = "scale(1)")}
            >
              <Send size={20} />
            </button>
          </div>
        </div>

        <div
          className="sidebar"
          style={{
            width: "280px",
            backgroundColor: "white",
            borderLeft: "1px solid #e5e7eb",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "16px",
              borderBottom: "1px solid #e5e7eb",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <Users size={20} color="#667eea" />
            <span
              style={{
                fontSize: "16px",
                fontWeight: "600",
                color: "#1f2937",
              }}
            >
              Online ({connectedUsers.length})
            </span>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "8px",
            }}
          >
            {connectedUsers.map((user) => (
              <div
                key={user.connectionId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "12px",
                  borderRadius: "8px",
                  marginBottom: "4px",
                  backgroundColor:
                    user.username === username ? "#f3f4f6" : "transparent",
                  transition: "background-color 0.2s",
                }}
                onMouseEnter={(e) => {
                  if (user.username !== username) {
                    e.currentTarget.style.backgroundColor = "#f9fafb";
                  }
                }}
                onMouseLeave={(e) => {
                  if (user.username !== username) {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }
                }}
              >
                <div
                  style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "50%",
                    background:
                      "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "white",
                    fontSize: "14px",
                    fontWeight: "600",
                    flexShrink: 0,
                  }}
                >
                  {user.username.charAt(0).toUpperCase()}
                </div>
                <span
                  style={{
                    flex: 1,
                    fontSize: "14px",
                    fontWeight: "500",
                    color: "#1f2937",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {user.username}
                  {user.username === username && (
                    <span
                      style={{
                        marginLeft: "6px",
                        fontSize: "12px",
                        color: "#6b7280",
                        fontWeight: "400",
                      }}
                    >
                      (You)
                    </span>
                  )}
                </span>
                <div
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    backgroundColor: "#10b981",
                    flexShrink: 0,
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% {
            transform: translateY(0);
          }
          40% {
            transform: translateY(-8px);
          }
        }
        
        .read-receipt {
          display: inline-block;
        }
        
        .read-receipt.grey {
          color: rgba(255, 255, 255, 0.6);
        }
        
        .read-receipt.blue {
          color: #33ff4b;
        }
        
        .read-receipt.failed {
          color: #ef4444;
          font-size: 16px;
          font-weight: bold;
        }

        *::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        
        *::-webkit-scrollbar-track {
          background: #f3f4f6;
        }
        
        *::-webkit-scrollbar-thumb {
          background: #d1d5db;
          border-radius: 4px;
        }
        
        *::-webkit-scrollbar-thumb:hover {
          background: #9ca3af;
        }

        @media (max-width: 768px) {
          .sidebar {
            display: none;
          }
        }
      `}</style>
    </div>
  );
};

export default ChatApp;