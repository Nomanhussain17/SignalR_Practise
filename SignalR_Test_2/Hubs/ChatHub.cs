using Microsoft.AspNetCore.SignalR;
using SignalR_Test_2.Dtos;
using SignalR_Test_2.Interface;
using System.Collections.Concurrent;

namespace SignalR_Test_2.Hubs
{
    public class ChatHub : Hub<IChatClient>
    {
        private static readonly ConcurrentDictionary<string, UserConnection> ConnectedUsers = new();
        private readonly ILogger<ChatHub> _logger;

        public ChatHub(ILogger<ChatHub> logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Gets the current list of unique usernames and broadcasts it to all clients.
        /// </summary>
        private async Task SendUserListUpdate()
        {
            try
            {
                var users = ConnectedUsers.Values
                    .Select(u => u.Username)
                    .Distinct()
                    .OrderBy(u => u)
                    .ToList();

                // Use the interface method to send the list to ALL clients
                await Clients.All.UpdateUserList(users);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending user list update");
            }
        }

        public override async Task OnConnectedAsync()
        {
            try
            {
                var httpContext = Context.GetHttpContext();
                var username = httpContext?.Request.Query["username"].ToString();

                // --- ADDED --- (Capture DeviceType from query)
                var deviceType = httpContext?.Request.Query["deviceType"].ToString();

                if (string.IsNullOrWhiteSpace(username))
                {
                    _logger.LogWarning("Connection attempt without username: {ConnectionId}", Context.ConnectionId);
                    Context.Abort();
                    return;
                }

                var userConnection = new UserConnection
                {
                    Username = username,
                    ConnectionId = Context.ConnectionId,
                    ConnectedAt = DateTime.UtcNow,
                    DeviceType = deviceType // --- ADDED ---
                };

                // Handle duplicate username connections
                var existingConnection = ConnectedUsers.Values
                    .FirstOrDefault(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));

                if (existingConnection != null)
                {
                    _logger.LogInformation("User {Username} reconnecting. Old: {OldId}, New: {NewId}",
                        username, existingConnection.ConnectionId, Context.ConnectionId);

                    // Remove old connection
                    ConnectedUsers.TryRemove(existingConnection.ConnectionId, out _);
                }

                // Add new connection
                if (ConnectedUsers.TryAdd(Context.ConnectionId, userConnection))
                {
                    // Add to user-specific group for targeted messaging
                    await Groups.AddToGroupAsync(Context.ConnectionId, username);

                    // Notify others a new user joined
                    await Clients.Others.NotifyNewUser(username);

                    _logger.LogInformation("User connected: {Username} ({ConnectionId})", username, Context.ConnectionId);

                    // --- MODIFICATION ---
                    // Send the updated list to EVERYONE (including the new user)
                    await SendUserListUpdate();
                }

                await base.OnConnectedAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in OnConnectedAsync for {ConnectionId}", Context.ConnectionId);
                throw;
            }
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            try
            {
                if (ConnectedUsers.TryRemove(Context.ConnectionId, out var userConnection))
                {
                    var username = userConnection.Username;

                    // Remove from user group
                    await Groups.RemoveFromGroupAsync(Context.ConnectionId, username);

                    // Determine delay based on client type
                    var disconnectDelay = GetReconnectionGracePeriod(userConnection);

                    // Wait for potential reconnection
                    await Task.Delay(disconnectDelay);

                    // Check if user reconnected with different connection ID
                    var stillConnected = ConnectedUsers.Values
                        .Any(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));

                    if (!stillConnected)
                    {
                        // Send "left" message
                        await Clients.All.ReceiveMessage("System", $"{username} left the chat", Guid.NewGuid().ToString());

                        _logger.LogInformation("User disconnected: {Username} ({ConnectionId}) after {Delay}ms grace period",
                            username, Context.ConnectionId, disconnectDelay);

                        // --- MODIFICATION ---
                        // Send the updated list to EVERYONE
                        await SendUserListUpdate();
                    }
                    else
                    {
                        _logger.LogInformation("User {Username} reconnected within grace period", username);
                    }
                }

                if (exception != null)
                {
                    _logger.LogError(exception, "Connection error for {ConnectionId}", Context.ConnectionId);
                }

                await base.OnDisconnectedAsync(exception);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in OnDisconnectedAsync for {ConnectionId}", Context.ConnectionId);
            }
        }

        // --- ALL OTHER METHODS FROM ORIGINAL FILE ---

        private int GetReconnectionGracePeriod(UserConnection userConnection)
        {
            // Check if client sent device type in connection
            var deviceType = userConnection.DeviceType?.ToLower();

            return deviceType switch
            {
                "mobile" or "ios" or "android" => 3000,  // Mobile: 3s
                "web" => 1500,                            // Web: 1.5s
                "desktop" => 1000,                        // Desktop: 1s
                _ => 2000                                 // Default: 2s (safe middle ground)
            };
        }

        public async Task SendMessage(string fromUser, string message, string messageId)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(message) || string.IsNullOrWhiteSpace(messageId))
                {
                    _logger.LogWarning("Invalid message from {FromUser}", fromUser);
                    return;
                }

                // Validate sender
                if (!ConnectedUsers.TryGetValue(Context.ConnectionId, out var sender) ||
                    !sender.Username.Equals(fromUser, StringComparison.OrdinalIgnoreCase))
                {
                    _logger.LogWarning("Unauthorized message attempt: {FromUser} - {ConnectionId}", fromUser, Context.ConnectionId);
                    return;
                }

                // Broadcast to all except sender
                await Clients.Others.ReceiveMessage(fromUser, message, messageId);

                _logger.LogDebug("Message sent: {FromUser} - {MessageId}", fromUser, messageId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending message from {FromUser}", fromUser);
                throw;
            }
        }

        public async Task Typing(string username)
        {
            try
            {
                if (ValidateUser(username))
                {
                    await Clients.Others.UserTyping(username);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in Typing for {Username}", username);
            }
        }

        public async Task StoppedTyping(string username)
        {
            try
            {
                if (ValidateUser(username))
                {
                    await Clients.Others.UserStoppedTyping(username);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in StoppedTyping for {Username}", username);
            }
        }

        public async Task ReactToMessage(string messageId, string fromUser, string emoji)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(messageId) || string.IsNullOrWhiteSpace(emoji))
                {
                    // Note: An empty emoji string might be intentional (to remove reaction)
                    // Allow "" but not null
                    if (emoji == null) return;
                }

                if (ValidateUser(fromUser))
                {
                    await Clients.All.ReceiveReaction(messageId, fromUser, emoji);
                    _logger.LogDebug("Reaction sent: {MessageId} - {Emoji} - {FromUser}", messageId, emoji, fromUser);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in ReactToMessage for {FromUser}", fromUser);
            }
        }

        public async Task MarkMessageAsSeen(string messageId, string seenByUser)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(messageId))
                {
                    return;
                }

                if (ValidateUser(seenByUser))
                {
                    await Clients.All.MessageSeen(messageId, seenByUser);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in MarkMessageAsSeen for {SeenByUser}", seenByUser);
            }
        }

        // Heartbeat to keep connection alive (call from client every 30s)
        public Task Ping()
        {
            return Task.CompletedTask;
        }

        // Get list of online users (No longer called by client, but can be kept for other purposes)
        public Task<List<string>> GetOnlineUsers()
        {
            var users = ConnectedUsers.Values
                .Select(u => u.Username)
                .Distinct()
                .OrderBy(u => u)
                .ToList();

            return Task.FromResult(users);
        }

        private bool ValidateUser(string username)
        {
            if (!ConnectedUsers.TryGetValue(Context.ConnectionId, out var user))
            {
                _logger.LogWarning("Invalid connection: {ConnectionId}", Context.ConnectionId);
                return false;
            }

            if (!user.Username.Equals(username, StringComparison.OrdinalIgnoreCase))
            {
                _logger.LogWarning("Username mismatch: Expected {Expected}, Got {Actual}", user.Username, username);
                return false;
            }

            return true;
        }

        public static List<UserConnection> GetAllConnectedUsers()
        {
            return ConnectedUsers.Values.ToList();
        }
    }
}