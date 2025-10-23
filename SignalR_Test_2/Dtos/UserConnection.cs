namespace SignalR_Test_2.Dtos
{
    public class UserConnection
    {
        public string? Username { get; set; }
        public string? ConnectionId { get; set; }
        public DateTime ConnectedAt { get; set; }
        public string? DeviceType { get; set; } 

    }
}
