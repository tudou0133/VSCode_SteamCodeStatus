using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Steamworks;


static class SteamNativeLoader
{
    private static int _installed = 0;

    public static void InstallOnce()
    {
        if (Interlocked.Exchange(ref _installed, 1) == 1) return;

        try
        {
            NativeLibrary.SetDllImportResolver(typeof(SteamAPI).Assembly, Resolve);
        }
        catch (Exception ex)
        {
            // Resolver 安装失败并不一定致命；让后续默认加载逻辑继续尝试。
            Console.WriteLine($"[Warn] Native resolver install failed: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, "steam_api", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(libraryName, "steam_api64", StringComparison.OrdinalIgnoreCase))
        {
            return IntPtr.Zero;
        }

        string fileName;

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            fileName = "steam_api64.dll";
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            fileName = "libsteam_api.so";
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            fileName = "libsteam_api.dylib";
        }
        else
        {
            return IntPtr.Zero;
        }

        string baseDir = AppContext.BaseDirectory;
        string fullPath = Path.Combine(baseDir, fileName);
        if (File.Exists(fullPath))
        {
            try
            {
                return NativeLibrary.Load(fullPath);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Warn] Failed to load native library from base dir: {fullPath} | {ex.Message}");
            }
        }

        try
        {
            return NativeLibrary.Load(fileName);
        }
        catch
        {
            return IntPtr.Zero;
        }
    }
}

static class SteamInitCompat
{
    public static bool TryInit(out string errorText)
    {
        errorText = string.Empty;

        try
        {
            // 优先尝试 InitEx(out string) —— 不直接强类型调用，避免不同 Steamworks.NET 版本签名差异导致编译失败。
            MethodInfo? initEx = typeof(SteamAPI)
                .GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(m =>
                {
                    if (!string.Equals(m.Name, "InitEx", StringComparison.Ordinal)) return false;
                    var ps = m.GetParameters();
                    return ps.Length == 1 && ps[0].IsOut && ps[0].ParameterType == typeof(string).MakeByRefType();
                });

            if (initEx != null)
            {
                object?[] args = new object?[] { string.Empty };
                object? result = initEx.Invoke(null, args);
                errorText = args[0] as string ?? string.Empty;
                return NormalizeInitResult(result, ref errorText);
            }

            // 再尝试无参 Init()
            MethodInfo? init = typeof(SteamAPI).GetMethod("Init", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
            if (init != null)
            {
                object? result = init.Invoke(null, null);
                return NormalizeInitResult(result, ref errorText);
            }

            errorText = "SteamAPI.Init / InitEx not found in current Steamworks assembly.";
            return false;
        }
        catch (TargetInvocationException tie)
        {
            errorText = tie.InnerException?.Message ?? tie.Message;
            return false;
        }
        catch (Exception ex)
        {
            errorText = ex.Message;
            return false;
        }
    }

    private static bool NormalizeInitResult(object? result, ref string errorText)
    {
        if (result == null)
        {
            errorText = string.IsNullOrWhiteSpace(errorText) ? "Steam init returned null." : errorText;
            return false;
        }

        if (result is bool b)
        {
            if (!b && string.IsNullOrWhiteSpace(errorText))
                errorText = "SteamAPI.Init returned false.";
            return b;
        }

        Type t = result.GetType();

        // 兼容新版 Steamworks.NET: 返回 ESteamAPIInitResult 枚举
        if (t.IsEnum)
        {
            string enumName = result.ToString() ?? string.Empty;
            if (string.Equals(enumName, "k_ESteamAPIInitResult_OK", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(enumName, "OK", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (string.IsNullOrWhiteSpace(errorText))
                errorText = $"Steam init result: {enumName}";
            return false;
        }

        // 最后兜底：有些版本可能返回 int/其他值
        if (result is int i)
        {
            if (i == 0) return true;
            if (string.IsNullOrWhiteSpace(errorText))
                errorText = $"Steam init returned int: {i}";
            return false;
        }

        if (string.IsNullOrWhiteSpace(errorText))
            errorText = $"Unexpected Steam init result type: {t.FullName}";
        return false;
    }
}

sealed class BridgeConfig
{
    public string TargetAppId { get; set; } = "480";
    public string DisplayTemplate { get; set; } = "#Status";
    public string DynamicKey { get; set; } = "status";
    public string GroupId { get; set; } = "";
    public string GroupSize { get; set; } = "";
    public int TcpPort { get; set; } = 0;
    public string TcpHost { get; set; } = "127.0.0.1";
    public readonly Dictionary<string, string> StaticFields = new Dictionary<string, string>();
}

sealed class RichPresenceBridge
{
    private readonly BridgeConfig _config;
    private readonly object _updateLock = new object();

    public RichPresenceBridge(BridgeConfig config)
    {
        _config = config;
    }

    public void ApplyStatus(string status, string source)
    {
        string normalized = status?.TrimEnd('\r', '\n') ?? string.Empty;
        if (string.IsNullOrEmpty(normalized))
        {
            Console.WriteLine($"[忽略] 来自 {source} 的空状态");
            return;
        }

        lock (_updateLock)
        {
            SteamFriends.ClearRichPresence();
            SteamFriends.SetRichPresence("steam_display", _config.DisplayTemplate);

            foreach (var field in _config.StaticFields)
            {
                SteamFriends.SetRichPresence(field.Key, field.Value);
            }

            if (!string.IsNullOrEmpty(_config.GroupId) && !string.IsNullOrEmpty(_config.GroupSize))
            {
                SteamFriends.SetRichPresence("steam_player_group", _config.GroupId);
                SteamFriends.SetRichPresence("steam_player_group_size", _config.GroupSize);
            }

            SteamFriends.SetRichPresence(_config.DynamicKey, normalized);
            Console.WriteLine($"[已更新][{source}] {_config.DynamicKey} = {normalized}");
        }
    }
}

class Program
{
    static void Main(string[] args)
    {
        SteamNativeLoader.InstallOnce();

        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        BridgeConfig config = ParseArgs(args);
        PrintConfig(config);

        Environment.SetEnvironmentVariable("SteamAppId", config.TargetAppId);

        try
        {
            string appIdTxt = Path.Combine(AppContext.BaseDirectory, "steam_appid.txt");
            File.WriteAllText(appIdTxt, config.TargetAppId);
        }
        catch
        {
            // 忽略 steam_appid.txt 写入失败
        }

        if (!SteamInitCompat.TryInit(out string steamErr))
        {
            Console.WriteLine("[错误] Steam Init 失败！请检查：1) Steam 客户端是否运行；2) 原生库是否在程序目录；3) AppID 是否正确。");
            Console.WriteLine("       Windows: steam_api64.dll");
            Console.WriteLine("       Linux:   libsteam_api.so");
            if (!string.IsNullOrWhiteSpace(steamErr))
                Console.WriteLine($"[错误] Steam: {steamErr}");
            return;
        }

        Console.WriteLine("[连接] Steam 连接成功！");

        Task.Run(() =>
        {
            while (true)
            {
                try
                {
                    SteamAPI.RunCallbacks();
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"[Warn] RunCallbacks failed: {ex.Message}");
                }

                Thread.Sleep(100);
            }
        });

        Console.CancelKeyPress += (_, e) =>
        {
            try { SteamAPI.Shutdown(); } catch { }
            e.Cancel = false;
        };

        RichPresenceBridge bridge = new RichPresenceBridge(config);

        List<Task> workers = new List<Task>
        {
            Task.Run(() => RunConsoleLoop(bridge))
        };

        if (config.TcpPort > 0)
        {
            workers.Add(Task.Run(() => RunTcpServerLoop(bridge, config.TcpHost, config.TcpPort)));
        }
        else
        {
            Console.WriteLine("[模式] 仅启用标准输入模式（兼容现有 VS Code 插件）");
        }

        Task.WaitAny(workers.ToArray());

        try { SteamAPI.Shutdown(); } catch { }
    }

    static BridgeConfig ParseArgs(string[] args)
    {
        BridgeConfig config = new BridgeConfig();

        for (int i = 0; i < args.Length; i++)
        {
            try
            {
                if (args[i] == "-app" && i + 1 < args.Length)
                    config.TargetAppId = args[i + 1];
                else if (args[i] == "-template" && i + 1 < args.Length)
                    config.DisplayTemplate = args[i + 1];
                else if (args[i] == "-key" && i + 1 < args.Length)
                    config.DynamicKey = args[i + 1];
                else if (args[i] == "-group" && i + 1 < args.Length)
                    config.GroupId = args[i + 1];
                else if (args[i] == "-groupsize" && i + 1 < args.Length)
                    config.GroupSize = args[i + 1];
                else if ((args[i] == "-tcp" || args[i] == "-tcpport") && i + 1 < args.Length)
                    config.TcpPort = SafeParsePort(args[i + 1]);
                else if (args[i] == "-tcphost" && i + 1 < args.Length)
                    config.TcpHost = args[i + 1];
                else if (args[i] == "-static" && i + 1 < args.Length)
                {
                    string[] parts = args[i + 1].Split('=', 2);
                    if (parts.Length == 2) config.StaticFields[parts[0]] = parts[1];
                }
            }
            catch
            {
                // 忽略格式错误的参数
            }
        }

        if (config.TcpPort <= 0)
        {
            string? envPort = Environment.GetEnvironmentVariable("STEAM_STATUS_TCP_PORT");
            if (!string.IsNullOrWhiteSpace(envPort))
                config.TcpPort = SafeParsePort(envPort);
        }

        string? envHost = Environment.GetEnvironmentVariable("STEAM_STATUS_TCP_HOST");
        if (!string.IsNullOrWhiteSpace(envHost) && string.IsNullOrWhiteSpace(config.TcpHost))
            config.TcpHost = envHost;

        if (string.IsNullOrWhiteSpace(config.TcpHost))
            config.TcpHost = "127.0.0.1";

        return config;
    }

    static int SafeParsePort(string text)
    {
        if (int.TryParse(text, out int port) && port > 0 && port <= 65535)
            return port;
        return 0;
    }

    static void PrintConfig(BridgeConfig config)
    {
        Console.WriteLine($"[配置] AppID: {config.TargetAppId}");
        Console.WriteLine($"[配置] Template: {config.DisplayTemplate}");
        Console.WriteLine($"[配置] Dynamic Key: {config.DynamicKey}");
        if (!string.IsNullOrEmpty(config.GroupId)) Console.WriteLine($"[配置] Group ID: {config.GroupId}");
        if (!string.IsNullOrEmpty(config.GroupSize)) Console.WriteLine($"[配置] Group Size: {config.GroupSize}");
        if (config.TcpPort > 0) Console.WriteLine($"[配置] TCP: {config.TcpHost}:{config.TcpPort}");
    }

    static void RunConsoleLoop(RichPresenceBridge bridge)
    {
        Console.WriteLine("[模式] 标准输入模式已启动");

        while (true)
        {
            string? inputString = Console.ReadLine();
            if (inputString == null)
            {
                Console.WriteLine("[模式] 标准输入已结束");
                break;
            }

            bridge.ApplyStatus(inputString, "STDIN");
        }
    }

    static void RunTcpServerLoop(RichPresenceBridge bridge, string host, int port)
    {
        IPAddress bindIp = ResolveListenIp(host);
        TcpListener listener = new TcpListener(bindIp, port);
        listener.Start();

        Console.WriteLine($"[模式] TCP 模式已启动，监听 {bindIp}:{port}");
        Console.WriteLine("[模式] TCP 协议：每行一条状态文本，发送换行即可更新状态");

        while (true)
        {
            TcpClient? client = null;
            try
            {
                client = listener.AcceptTcpClient();
                string remote = client.Client.RemoteEndPoint?.ToString() ?? "unknown";
                Console.WriteLine($"[TCP] 客户端已连接: {remote}");
                HandleTcpClient(client, bridge, remote);
                Console.WriteLine($"[TCP] 客户端已断开: {remote}");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Warn] TCP server error: {ex.Message}");
                try { client?.Close(); } catch { }
                Thread.Sleep(300);
            }
        }
    }

    static void HandleTcpClient(TcpClient client, RichPresenceBridge bridge, string remote)
    {
        using (client)
        using (NetworkStream stream = client.GetStream())
        using (StreamReader reader = new StreamReader(stream, new UTF8Encoding(false)))
        using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" })
        {
            writer.WriteLine("OK SteamCodeStatus TCP bridge ready");

            while (true)
            {
                string? line = reader.ReadLine();
                if (line == null) break;

                string trimmed = line.Trim();
                if (trimmed.Length == 0)
                {
                    writer.WriteLine("IGNORED empty");
                    continue;
                }

                if (string.Equals(trimmed, "PING", StringComparison.OrdinalIgnoreCase))
                {
                    writer.WriteLine("PONG");
                    continue;
                }

                if (string.Equals(trimmed, "QUIT", StringComparison.OrdinalIgnoreCase))
                {
                    writer.WriteLine("BYE");
                    break;
                }

                bridge.ApplyStatus(line, $"TCP:{remote}");
                writer.WriteLine("OK");
            }
        }
    }

    static IPAddress ResolveListenIp(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
            return IPAddress.Loopback;

        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
            return IPAddress.Loopback;

        if (string.Equals(host, "0.0.0.0", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(host, "*", StringComparison.OrdinalIgnoreCase))
            return IPAddress.Any;

        if (IPAddress.TryParse(host, out IPAddress? ip))
            return ip;

        try
        {
            IPAddress? resolved = Dns.GetHostAddresses(host)
                .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork);
            return resolved ?? IPAddress.Loopback;
        }
        catch
        {
            return IPAddress.Loopback;
        }
    }
}
