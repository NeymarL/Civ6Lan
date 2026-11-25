using System;
using System.Collections.Generic;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;

public static class Civ6Broadcast
{
    public static void Run(string target, int controlPort, string token)
    {
        IPAddress tunnel = IPAddress.Parse(target);
        var local = new HashSet<uint>();
        foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            foreach (UnicastIPAddressInformation ip in adapter.GetIPProperties().UnicastAddresses)
            {
                if (ip.Address.AddressFamily == AddressFamily.InterNetwork &&
                    !IPAddress.IsLoopback(ip.Address) && !ip.Address.Equals(tunnel))
                    local.Add(AddressNumber(ip.Address.GetAddressBytes(), 0));
            }
        }

        using (var capture = new Socket(AddressFamily.InterNetwork, SocketType.Raw, ProtocolType.Udp))
        using (var relay = new Socket(AddressFamily.InterNetwork, SocketType.Raw, ProtocolType.Udp))
        using (var control = new TcpClient(AddressFamily.InterNetwork))
        {
            capture.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            capture.ReceiveTimeout = 500;
            relay.Bind(new IPEndPoint(tunnel, 0));
            relay.EnableBroadcast = true;
            relay.Ttl = 1;
            relay.SendTimeout = 500;

            control.Connect(IPAddress.Loopback, controlPort);
            byte[] message = Encoding.ASCII.GetBytes(token + "\n");
            control.GetStream().Write(message, 0, message.Length);

            byte[] packet = new byte[65535];
            var destination = new IPEndPoint(IPAddress.Broadcast, 0);
            byte[] source = tunnel.GetAddressBytes();
            while (!control.Client.Poll(0, SelectMode.SelectRead))
            {
                int count;
                try { count = capture.Receive(packet); }
                catch (SocketException error)
                {
                    if (error.SocketErrorCode != SocketError.TimedOut && error.SocketErrorCode != SocketError.WouldBlock) throw;
                    continue;
                }

                int udp = DiscoveryOffset(packet, count, local);
                if (udp == 0) continue;
                int length = Word(packet, udp + 4);
                packet[udp + 6] = 0;
                packet[udp + 7] = 0;
                int checksum = UdpChecksum(packet, udp, length, source);
                packet[udp + 6] = (byte)(checksum >> 8);
                packet[udp + 7] = (byte)(checksum & 255);
                relay.SendTo(packet, udp, length, SocketFlags.None, destination);
            }
        }
    }

    internal static int DiscoveryOffset(byte[] packet, int count, HashSet<uint> local)
    {
        if (count < 28 || packet[0] >> 4 != 4 || packet[9] != 17 || packet[8] <= 1 ||
            (Word(packet, 6) & 0x3fff) != 0 || AddressNumber(packet, 16) != uint.MaxValue ||
            !local.Contains(AddressNumber(packet, 12))) return 0;
        int udp = (packet[0] & 15) * 4;
        if (udp < 20 || count < udp + 8) return 0;
        int port = Word(packet, udp + 2);
        int length = Word(packet, udp + 4);
        return port >= 62900 && port <= 62999 && length >= 8 && udp + length <= count ? udp : 0;
    }

    internal static int UdpChecksum(byte[] packet, int offset, int length, byte[] source)
    {
        uint sum = (uint)(Word(source, 0) + Word(source, 2) + 0xffff + 0xffff + 17 + length);
        for (int i = 0; i + 1 < length; i += 2) sum += (uint)Word(packet, offset + i);
        if ((length & 1) != 0) sum += (uint)packet[offset + length - 1] << 8;
        while ((sum >> 16) != 0) sum = (sum & 0xffff) + (sum >> 16);
        return sum == 0xffff ? 0xffff : (int)(~sum & 0xffff);
    }

    private static int Word(byte[] bytes, int i) { return bytes[i] << 8 | bytes[i + 1]; }
    private static uint AddressNumber(byte[] bytes, int i) { return (uint)Word(bytes, i) << 16 | (uint)Word(bytes, i + 2); }
}
