using System;
using System.Threading;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using Steamworks;

class Program
{
    static void Main(string[] args)
    {
        // 1. 设置通信编码
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;

        // 2. 定义配置变量
        string targetAppId = "480";           // 默认 Spacewar
        string displayTemplate = "#Status";   // 默认模板
        string dynamicKey = "status";         // 默认动态字段 key
        
        // [新增] 组队相关变量 (默认为空字符串，表示不启用)
        string groupId = "";
        string groupSize = "";

        // 静态字段字典
        Dictionary<string, string> staticFields = new Dictionary<string, string>();

        // 3. 解析命令行参数
        // 新增支持: -group <id> -groupsize <size>
        for (int i = 0; i < args.Length; i++)
        {
            try 
            {
                if (args[i] == "-app" && i + 1 < args.Length) 
                    targetAppId = args[i + 1];
                
                else if (args[i] == "-template" && i + 1 < args.Length) 
                    displayTemplate = args[i + 1];
                
                else if (args[i] == "-key" && i + 1 < args.Length) 
                    dynamicKey = args[i + 1];

                // [新增] 解析组 ID
                else if (args[i] == "-group" && i + 1 < args.Length)
                    groupId = args[i + 1];

                // [新增] 解析组人数
                else if (args[i] == "-groupsize" && i + 1 < args.Length)
                    groupSize = args[i + 1];

                else if (args[i] == "-static" && i + 1 < args.Length)
                {
                    string[] parts = args[i + 1].Split('=');
                    if (parts.Length == 2) staticFields[parts[0]] = parts[1];
                }
            }
            catch { /* 忽略格式错误的参数 */ }
        }

        Console.WriteLine($"[配置] AppID: {targetAppId}");
        Console.WriteLine($"[配置] Template: {displayTemplate}");
        // 仅在有值时打印日志
        if (!string.IsNullOrEmpty(groupId)) Console.WriteLine($"[配置] Group ID: {groupId}");
        if (!string.IsNullOrEmpty(groupSize)) Console.WriteLine($"[配置] Group Size: {groupSize}");

        // 4. 设置环境变量
        Environment.SetEnvironmentVariable("SteamAppId", targetAppId);

        // 5. 初始化 Steam API
        if (!SteamAPI.Init())
        {
            Console.WriteLine("[错误] Steam Init 失败！请检查 Steam 客户端是否运行。");
            return;
        }

        Console.WriteLine("[连接] Steam 连接成功！");

        // 6. 启动心跳线程
        Task.Run(() => 
        {
            while (true)
            {
                SteamAPI.RunCallbacks();
                Thread.Sleep(100);
            }
        });

        // 7. 主循环
        while (true)
        {
            string inputString = Console.ReadLine();
            if (inputString == null) break;

            // 7.1 清除旧状态
            // 注意：ClearRichPresence 会清除所有键值，所以下面必须重新设置所有项
            SteamFriends.ClearRichPresence();

            // 7.2 设置基础信息
            SteamFriends.SetRichPresence("steam_display", displayTemplate);

            // 7.3 设置静态字段
            foreach (var field in staticFields)
            {
                SteamFriends.SetRichPresence(field.Key, field.Value);
            }

            // 7.4 [新增] 设置组队信息 (安全检查)
            // 只有当参数存在且不为空字符串时才发送
            if (!string.IsNullOrEmpty(groupId) && !string.IsNullOrEmpty(groupSize))
            {
                SteamFriends.SetRichPresence("steam_player_group", groupId);
                SteamFriends.SetRichPresence("steam_player_group_size", groupSize);
            } 
            else
            {
                // 如果没有组 ID，则清除组队相关字段以避免显示错误信息
                SteamFriends.SetRichPresence("steam_player_group", null);
                SteamFriends.SetRichPresence("steam_player_group_size", null);
            }

            // 7.5 设置动态内容
            SteamFriends.SetRichPresence(dynamicKey, inputString);

            Console.WriteLine($"[已更新] {inputString}");
        }

        SteamAPI.Shutdown();
    }
}
