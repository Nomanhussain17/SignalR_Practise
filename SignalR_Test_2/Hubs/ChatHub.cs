using Microsoft.AspNetCore.SignalR;
using SignalR_Test_2.Dtos;
using SignalR_Test_2.Interface;
using System.Collections.Concurrent;

namespace SignalR_Test_2.Hubs
{
    public class ChatHub : Hub<IChatClient>
    {
        private static readonly ConcurrentDictionary<string, UserConnection> ConnectedUsers = new();
        private static readonly ConcurrentDictionary<string, string> SessionToUsername = new();
        private static readonly ConcurrentDictionary<string, DateTime> DisconnectingUsers = new();
        private static readonly ConcurrentDictionary<string, bool> ExplicitLogouts = new();

        private readonly ILogger<ChatHub> _logger;

        public ChatHub(ILogger<ChatHub> logger) => _logger = logger;

        
        /// Collects all unique usernames from connected users and broadcasts the updated list to all clients.

        private async Task SendUserListUpdate()
        {
            try
            {
                var users = ConnectedUsers.Values
                    .Select(u => u.Username)
                    .Distinct()
                    .OrderBy(u => u)
                    .ToList();

                await Clients.All.UpdateUserList(users);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending user list update");
            }
        }

        
        /// Handles new client connections. Validates username and sessionId, manages session switching,
        /// tracks reconnections, adds user to the connected users dictionary, and notifies other clients if it's a new user.

        public override async Task OnConnectedAsync()
        {
            try
            {
                var httpContext = Context.GetHttpContext();
                var username = httpContext?.Request.Query["username"].ToString();
                var deviceType = httpContext?.Request.Query["deviceType"].ToString();
                var sessionId = httpContext?.Request.Query["sessionId"].ToString();

                if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(sessionId))
                {
                    _logger.LogWarning("Connection attempt without {Missing}: {ConnectionId}",
                        string.IsNullOrWhiteSpace(username) ? "username" : "sessionId", Context.ConnectionId);
                    Context.Abort();
                    return;
                }

                await HandleSessionSwitch(sessionId, username);

                var wasReconnecting = DisconnectingUsers.TryRemove(username, out _);
                ExplicitLogouts.TryRemove(username, out _);

                var userConnection = new UserConnection
                {
                    Username = username,
                    ConnectionId = Context.ConnectionId,
                    ConnectedAt = DateTime.UtcNow,
                    DeviceType = deviceType,
                    SessionId = sessionId
                };

                if (ConnectedUsers.TryAdd(Context.ConnectionId, userConnection))
                {
                    var isFirstConnection = ConnectedUsers.Values
                        .Count(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase)) == 1;

                    await Groups.AddToGroupAsync(Context.ConnectionId, username);

                    if (isFirstConnection && !wasReconnecting)
                    {
                        await Clients.Others.NotifyNewUser(username);
                    }

                    _logger.LogInformation(
                        "User connected: {Username} ({ConnectionId}) from Session {SessionId}. WasReconnecting: {WasReconnecting}, IsFirstConnection: {IsFirstConnection}",
                        username, Context.ConnectionId, sessionId, wasReconnecting, isFirstConnection);

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

        
        /// Handles session switching when a different user tries to connect with a session ID that was previously used by another user.
        /// Removes all connections of the previous user, cleans up their data, and notifies all clients that the previous user left.

        private async Task HandleSessionSwitch(string sessionId, string username)
        {
            if (!SessionToUsername.TryGetValue(sessionId, out var previousUsername) ||
                previousUsername.Equals(username, StringComparison.OrdinalIgnoreCase))
            {
                SessionToUsername.AddOrUpdate(sessionId, username, (_, _) => username);
                return;
            }

            _logger.LogInformation(
                "Session {SessionId} switching from user '{PreviousUsername}' to '{NewUsername}'",
                sessionId, previousUsername, username);

            var oldConnections = ConnectedUsers
                .Where(kvp => kvp.Value.Username.Equals(previousUsername, StringComparison.OrdinalIgnoreCase))
                .Select(kvp => kvp.Key)
                .ToList();

            foreach (var oldConnectionId in oldConnections)
            {
                if (ConnectedUsers.TryRemove(oldConnectionId, out _))
                {
                    await Groups.RemoveFromGroupAsync(oldConnectionId, previousUsername);
                }
            }

            DisconnectingUsers.TryRemove(previousUsername, out _);
            ExplicitLogouts.TryRemove(previousUsername, out _);

            await Clients.All.ReceiveMessage("System", $"{previousUsername} left the chat", Guid.NewGuid().ToString());

            _logger.LogInformation("Previous user {PreviousUsername} completely removed due to session switch", previousUsername);

            await SendUserListUpdate();
            SessionToUsername.AddOrUpdate(sessionId, username, (_, _) => username);
        }

        
        /// Handles client disconnections. Removes the connection from the dictionary, checks if the user has other active connections,
        /// and either processes an explicit logout or starts a grace period for potential reconnection (e.g., page refresh).

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            try
            {
                if (!ConnectedUsers.TryRemove(Context.ConnectionId, out var userConnection))
                {
                    if (exception != null)
                        _logger.LogError(exception, "Connection error for {ConnectionId}", Context.ConnectionId);
                    await base.OnDisconnectedAsync(exception);
                    return;
                }

                var username = userConnection.Username;
                var sessionId = userConnection.SessionId;

                await Groups.RemoveFromGroupAsync(Context.ConnectionId, username);

                _logger.LogInformation("Connection {ConnectionId} removed for user {Username}", Context.ConnectionId, username);

                if (IsUserStillConnected(username))
                {
                    _logger.LogInformation(
                        "User {Username} disconnected from {ConnectionId}, but remains connected on other sessions.",
                        username, Context.ConnectionId);
                    await SendUserListUpdate();
                    await base.OnDisconnectedAsync(exception);
                    return;
                }

                if (ExplicitLogouts.TryRemove(username, out _))
                {
                    await HandleExplicitLogout(username, sessionId);
                    await base.OnDisconnectedAsync(exception);
                    return;
                }

                await HandleGracefulDisconnect(username, sessionId, userConnection);

                if (exception != null)
                    _logger.LogError(exception, "Connection error for {ConnectionId}", Context.ConnectionId);

                await base.OnDisconnectedAsync(exception);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in OnDisconnectedAsync for {ConnectionId}", Context.ConnectionId);
            }
        }

        
        /// Checks if a user still has any active connections (from any device/session).

        private bool IsUserStillConnected(string username) =>
            ConnectedUsers.Values.Any(u => u.Username.Equals(username, StringComparison.OrdinalIgnoreCase));

        
        /// Processes an explicit logout (user clicked logout button). Immediately removes the user without a grace period,
        /// cleans up session mappings, and notifies all clients that the user left the chat.

        private async Task HandleExplicitLogout(string username, string sessionId)
        {
            _logger.LogInformation("User {Username} explicitly logged out. Immediate disconnect.", username);

            CleanupSession(sessionId, username);
            DisconnectingUsers.TryRemove(username, out _);

            await Clients.All.ReceiveMessage("System", $"{username} left the chat", Guid.NewGuid().ToString());
            await SendUserListUpdate();
        }

        
        /// Handles disconnection with a grace period to allow for reconnection (e.g., page refresh, temporary network loss).
        /// Waits for a device-specific delay before permanently removing the user. If the user reconnects during this period,
        /// no disconnection message is sent. Otherwise, the user is marked as permanently disconnected.

        private async Task HandleGracefulDisconnect(string username, string sessionId, UserConnection userConnection)
        {
            _logger.LogInformation("User {Username}'s last connection closed. Starting grace period...", username);

            DisconnectingUsers.TryAdd(username, DateTime.UtcNow);

            var disconnectDelay = GetReconnectionGracePeriod(userConnection);
            await Task.Delay(disconnectDelay);

            if (IsUserStillConnected(username))
            {
                DisconnectingUsers.TryRemove(username, out _);
                _logger.LogInformation("User {Username} reconnected during grace period. No disconnection message sent.", username);
                await SendUserListUpdate();
                return;
            }

            DisconnectingUsers.TryRemove(username, out _);
            CleanupSession(sessionId, username);

            await Clients.All.ReceiveMessage("System", $"{username} left the chat", Guid.NewGuid().ToString());

            _logger.LogInformation(
                "User permanently disconnected: {Username} (Last connection {ConnectionId}) after {Delay}ms grace period",
                username, Context.ConnectionId, disconnectDelay);

            await SendUserListUpdate();
        }

        
        /// Removes the session-to-username mapping when a user permanently disconnects.
        /// Only removes the mapping if it still points to the specified username (prevents removing mappings for session reuse).

        private void CleanupSession(string sessionId, string username)
        {
            if (string.IsNullOrEmpty(sessionId)) return;

            if (SessionToUsername.TryGetValue(sessionId, out var mappedUsername) &&
                mappedUsername.Equals(username, StringComparison.OrdinalIgnoreCase))
            {
                SessionToUsername.TryRemove(sessionId, out _);
                _logger.LogInformation("Removed session mapping for {SessionId} -> {Username}", sessionId, username);
            }
        }

        
        /// Called by the client when they explicitly logout (not a page refresh or accidental disconnect).
        /// Marks the user for immediate disconnection without a grace period.

        public async Task ExplicitLogout(string username)
        {
            try
            {
                if (!ValidateUser(username)) return;

                _logger.LogInformation("User {Username} initiated explicit logout", username);
                ExplicitLogouts.TryAdd(username, true);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in ExplicitLogout for {Username}", username);
            }
        }

        
        /// Returns the reconnection grace period in milliseconds based on the device type.
        /// Mobile devices get longer grace periods (3s) due to less stable connections,
        /// while desktop gets shorter periods (1s) as they're typically more stable.

        private int GetReconnectionGracePeriod(UserConnection userConnection) =>
            userConnection.DeviceType?.ToLower() switch
            {
                "mobile" or "ios" or "android" => 3000,
                "web" => 1500,
                "desktop" => 1000,
                _ => 2000
            };

        
        /// Sends a chat message from one user to all other connected clients.
        /// Validates that the sender is authorized and broadcasts both the message and a notification.

        public async Task SendMessage(string fromUser, string message, string messageId)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(message) || string.IsNullOrWhiteSpace(messageId))
                {
                    _logger.LogWarning("Invalid message from {FromUser}", fromUser);
                    return;
                }

                if (!ConnectedUsers.TryGetValue(Context.ConnectionId, out var sender) ||
                    !sender.Username.Equals(fromUser, StringComparison.OrdinalIgnoreCase))
                {
                    _logger.LogWarning("Unauthorized message attempt: {FromUser} - {ConnectionId}", fromUser, Context.ConnectionId);
                    return;
                }

                await Clients.Others.ReceiveMessage(fromUser, message, messageId);
                await Clients.Others.ReceiveNotification(fromUser, message, messageId);

                _logger.LogDebug("Message sent: {FromUser} - {MessageId}", fromUser, messageId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error sending message from {FromUser}", fromUser);
                throw;
            }
        }

        
        /// Notifies all other clients that a user is currently typing a message.

        public async Task Typing(string username)
        {
            try
            {
                if (ValidateUser(username))
                    await Clients.Others.UserTyping(username);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in Typing for {Username}", username);
            }
        }

        
        /// Notifies all other clients that a user has stopped typing.

        public async Task StoppedTyping(string username)
        {
            try
            {
                if (ValidateUser(username))
                    await Clients.Others.UserStoppedTyping(username);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in StoppedTyping for {Username}", username);
            }
        }

        
        /// Broadcasts a reaction (emoji) to a specific message to all connected clients.

        public async Task ReactToMessage(string messageId, string fromUser, string emoji)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(messageId) || emoji == null) return;

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

        
        /// Marks a message as seen by a specific user and broadcasts this status to all clients.
        /// Used for read receipts functionality.

        public async Task MarkMessageAsSeen(string messageId, string seenByUser)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(messageId)) return;

                if (ValidateUser(seenByUser))
                    await Clients.All.MessageSeen(messageId, seenByUser);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in MarkMessageAsSeen for {SeenByUser}", seenByUser);
            }
        }

        
        /// Simple ping method to keep the connection alive. Returns immediately without any action.

        public Task Ping() => Task.CompletedTask;

        
        /// Returns a list of all currently online users (unique usernames only, sorted alphabetically).

        public Task<List<string>> GetOnlineUsers()
        {
            var users = ConnectedUsers.Values
                .Select(u => u.Username)
                .Distinct()
                .OrderBy(u => u)
                .ToList();

            return Task.FromResult(users);
        }

        
        /// Validates that the current connection belongs to the specified username.
        /// Prevents users from sending messages or performing actions on behalf of other users.

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

        
        /// Static method to get all currently connected users with their full connection details.
        /// Useful for debugging or admin monitoring purposes.

        public static List<UserConnection> GetAllConnectedUsers() => ConnectedUsers.Values.ToList();
    }
}