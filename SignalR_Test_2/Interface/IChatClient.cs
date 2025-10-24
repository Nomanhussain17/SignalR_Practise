namespace SignalR_Test_2.Interface
{
    public interface IChatClient
    {
        Task ReceiveMessage(string user, string message, string messageId);
        Task NotifyNewUser(string username);
        Task UserTyping(string username);
        Task UserStoppedTyping(string username);
        Task ReceiveReaction(string messageId, string fromUser, string emoji);
        Task MessageSeen(string messageId, string seenByUser);
        Task UpdateUserList(List<string> users);
        Task ReceiveNotification(string fromUser, string message, string messageId);
    }
}
