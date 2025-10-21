using Microsoft.AspNetCore.SignalR;
using SignalR_Test_2.Interface;
using System.Collections.Concurrent;

namespace SignalR_Test_2.Hubs
{

    public class ChatHub : Hub<IChatClient>
    {
        private static readonly ConcurrentDictionary<string, string> ConnectedUsers = new();

        public override async Task OnConnectedAsync()
        {
            var username = Context.GetHttpContext()?.Request.Query["username"];
            if (!string.IsNullOrEmpty(username))
            {
                ConnectedUsers[Context.ConnectionId] = username!;
                await Clients.All.NotifyNewUser(username!);
            }

            await base.OnConnectedAsync();
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            if (ConnectedUsers.TryRemove(Context.ConnectionId, out var username))
            {
                await Clients.All.ReceiveMessage("System", $"{username} left the chat");
            }

            await base.OnDisconnectedAsync(exception);
        }

        public async Task SendMessage(string fromUser, string message)
        {
            await Clients.Others.ReceiveMessage(fromUser, message);
        }

        public async Task Typing(string username)
        {
            await Clients.Others.UserTyping(username);
        }

        public async Task StoppedTyping(string username)
        {
            await Clients.Others.UserStoppedTyping(username);
        }

        public async Task ReactToMessage(string messageId, string fromUser, string emoji)
        {
            // Broadcast to everyone (except the sender)
            await Clients.Others.ReceiveReaction(messageId, fromUser, emoji);
        }

        public static ConcurrentDictionary<string, string> GetConnectedUsers()
        {
            return ConnectedUsers;
        }
    }
}
