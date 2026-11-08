// The native transport of the Hawkes playtest contract v2 (spec: hawkesstudio/docs/playtest.md, "The native
// transport"), for every player except WebGL: Windows, Linux and macOS, Mono and IL2CPP, and the editor.
//
// A native runner launches the game with HAWKES_PLAYTEST=ws://127.0.0.1:<port>/<token> (or the argument
// --hawkes-playtest=<url>). When Register sees it, this connects out with System.Net.WebSockets.ClientWebSocket on a
// background thread. Received messages queue up and are handled on the main thread in the driver's Update; what the
// game sends queues up and the background thread writes it. Without the address nothing here runs: no socket, no
// thread, no per-frame work beyond one null check.

#if !UNITY_WEBGL || UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace Hawkes.Playtest
{
    public static partial class HawkesPlaytest
    {
        /// <summary>The environment variable a native runner sets (the argument --hawkes-playtest=&lt;url&gt; wins over it).</summary>
        public const string AddressVariable = "HAWKES_PLAYTEST";
        const string AddressArgument = "--hawkes-playtest";

        static NativeLink _native;
        static bool _nativeChecked;
        static string _nativeLastStatus;
        static float _nativeNextState;
        static bool _nativeWarned;
        static bool _nativeWasOpen;

        /// <summary>True while a native runner is connected.</summary>
        public static bool NativeConnected => _native != null && _native.IsOpen;

        /// <summary>The runner's address from the command line or the environment, or null (a normal launch).</summary>
        public static string NativeAddress()
        {
            try
            {
                var args = Environment.GetCommandLineArgs();
                for (var i = 0; i < args.Length; i++)
                {
                    var a = args[i];
                    if (a.StartsWith(AddressArgument + "=", StringComparison.Ordinal))
                    {
                        var v = a.Substring(AddressArgument.Length + 1);
                        if (v.Length > 0) return v;
                    }
                    else if (a == AddressArgument && i + 1 < args.Length && args[i + 1].Length > 0) return args[i + 1];
                }
                var env = Environment.GetEnvironmentVariable(AddressVariable);
                return string.IsNullOrEmpty(env) ? null : env;
            }
            catch
            {
                return null;
            }
        }

        static partial void NativeConnect()
        {
            if (_native != null)
            {
                _native.Send(HelloJson()); // registered again: new scenarios
                return;
            }
            if (_nativeChecked) return;
            _nativeChecked = true;
            var address = NativeAddress();
            if (address == null) return;
            Uri uri;
            if (!Uri.TryCreate(address, UriKind.Absolute, out uri) || (uri.Scheme != "ws" && uri.Scheme != "wss"))
            {
                Debug.LogWarning("[HawkesPlaytest] " + AddressVariable + " is not a ws:// address; playing without the runner");
                return;
            }
            // A runner plays the game unfocused, often off-screen: keep the player loop going.
            Application.runInBackground = true;
            _native = new NativeLink(uri);
            _native.Send(HelloJson()); // queued first, so it is the first message on the socket
            Application.logMessageReceivedThreaded += NativeOnLog;
            Application.quitting += NativeOnQuit;
            _native.Start();
        }

        static void NativeOnQuit()
        {
            Application.logMessageReceivedThreaded -= NativeOnLog;
            _native?.Close(500);
        }

        // Any thread. Every log line goes to the runner, rate-limited inside the link.
        static void NativeOnLog(string message, string stack, LogType type)
        {
            var link = _native;
            if (link == null || link.IsEnded) return;
            var level = type == LogType.Log ? "info" : type == LogType.Warning ? "warning" : "error";
            var line = type == LogType.Exception && !string.IsNullOrEmpty(stack) ? message + "\n" + stack : message;
            link.SendLog(level, line);
        }

        static partial void NativeEvent(PlaytestRun run, float t, string type, string detail)
        {
            if (_native == null) return;
            var sb = new StringBuilder(96);
            sb.Append("{\"type\":\"event\",\"event\":{\"t\":").Append(Json.Num(t)).Append(",\"type\":").Append(Json.Str(type));
            if (detail != null) sb.Append(",\"detail\":").Append(Json.Str(detail));
            _native.Send(sb.Append("}}").ToString());
        }

        static partial void NativeFinished(PlaytestRun run)
        {
            if (_native == null) return;
            SendState(null);
            _native.Send("{\"type\":\"report\",\"report\":" + run.ReportJson() + "}");
        }

        // Main thread, every frame from the driver.
        static partial void NativeUpdate()
        {
            var link = _native;
            if (link == null) return;
            if (link.IsOpen) _nativeWasOpen = true;
            if (link.IsEnded)
            {
                if (!_nativeWarned)
                {
                    _nativeWarned = true;
                    if (_nativeWasOpen)
                    {
                        // The runner went away: stop the bot, as the spec says (the game itself keeps running).
                        if (Current != null && !Current.Done) Stop();
                    }
                    else Debug.LogWarning("[HawkesPlaytest] could not reach the playtest runner (" + link.Error + "); playing without it");
                }
                return;
            }
            string text;
            var handled = 0;
            while (handled < 64 && link.TryReceive(out text))
            {
                handled++;
                try { HandleNative(text); }
                catch (Exception e) { Debug.LogException(e); }
            }
            if (!link.IsOpen) return;
            var status = Current == null ? "idle" : Current.Done ? Current.Outcome.ToString() : "running";
            if (status != _nativeLastStatus || Time.realtimeSinceStartup >= _nativeNextState) SendState(null);
        }

        static void SendState(long? re)
        {
            var run = Current;
            _nativeLastStatus = run == null ? "idle" : run.Done ? run.Outcome.ToString() : "running";
            _nativeNextState = Time.realtimeSinceStartup + 0.5f;
            var sb = new StringBuilder(256).Append("{\"type\":\"state\"");
            if (re.HasValue) sb.Append(",\"re\":").Append(re.Value.ToString(CultureInfo.InvariantCulture));
            _native.Send(sb.Append(",\"state\":").Append(StateJson()).Append('}').ToString());
        }

        static void Ack(long? id, bool ok, string error = null)
        {
            if (!id.HasValue) return;
            var sb = new StringBuilder(64).Append("{\"type\":\"ack\",\"re\":").Append(id.Value.ToString(CultureInfo.InvariantCulture))
                .Append(",\"ok\":").Append(ok ? "true" : "false");
            if (error != null) sb.Append(",\"error\":").Append(Json.Str(error));
            _native.Send(sb.Append('}').ToString());
        }

        /// <summary>One message from the runner, on the main thread. Exposed for tests.</summary>
        internal static void HandleNative(string text)
        {
            Dictionary<string, object> m;
            try { m = MiniJson.Parse(text) as Dictionary<string, object>; }
            catch { m = null; }
            if (m == null) return; // not JSON: no id to answer
            var type = MiniJson.Str(m, "type");
            var id = MiniJson.Long(m, "id");
            switch (type)
            {
                case "welcome":
                    break;
                case "start":
                {
                    var scenario = MiniJson.Str(m, "scenario");
                    if (string.IsNullOrEmpty(scenario)) { Ack(id, false, "start needs a scenario"); break; }
                    if (_bot == null) { Ack(id, false, "HawkesPlaytest.Register was not called"); break; }
                    object raw;
                    var opts = m.TryGetValue("options", out raw) ? raw as Dictionary<string, object> : null;
                    var options = new PlaytestOptions();
                    if (opts != null)
                    {
                        var seed = MiniJson.Num(opts, "seed");
                        var speed = MiniJson.Num(opts, "speed");
                        if (seed.HasValue) options.seed = (int)seed.Value;
                        if (speed.HasValue) options.speed = (float)speed.Value;
                        options.at = MiniJson.Str(opts, "at") ?? "";
                        options.spot = MiniJson.Str(opts, "spot") ?? "";
                        options.json = MiniJson.Write(opts);
                    }
                    var known = HasScenario(scenario);
                    StartScenario(scenario, options); // an unknown one finishes at once as Error, as in a page
                    if (known) Ack(id, true);
                    else Ack(id, false, "no playtest scenario \"" + scenario + "\"");
                    break;
                }
                case "stop":
                    Stop();
                    Ack(id, true);
                    break;
                case "input":
                {
                    var action = MiniJson.Str(m, "action");
                    object down;
                    var isDown = m.TryGetValue("down", out down) && down is bool && (bool)down;
                    if (_input == null) { Ack(id, false, "the game takes no runner input"); break; }
                    if (string.IsNullOrEmpty(action)) { Ack(id, false, "input needs an action"); break; }
                    _input(action, isDown);
                    Ack(id, true);
                    break;
                }
                case "state?":
                    if (id.HasValue) SendState(id);
                    break;
                case "report?":
                    if (id.HasValue)
                        _native.Send("{\"type\":\"report\",\"re\":" + id.Value.ToString(CultureInfo.InvariantCulture) +
                                     ",\"report\":" + (Current != null ? Current.ReportJson() : "null") + "}");
                    break;
                case "quit":
                    Ack(id, true);
                    if (Current != null && !Current.Done) Stop();
                    _native.Close(500);
                    Application.Quit();
                    break;
                default:
                    if (id.HasValue && !string.IsNullOrEmpty(type) && type.EndsWith("?", StringComparison.Ordinal))
                        Ack(id, false, "unknown request " + type);
                    break; // unknown pushes are ignored
            }
        }

        static string HelloJson()
        {
            var sb = new StringBuilder(512);
            sb.Append("{\"type\":\"hello\",\"version\":").Append(ContractVersion);
            sb.Append(",\"product\":").Append(Json.Str(Product ?? ""));
            sb.Append(",\"scenarios\":").Append(ScenariosJson());
            sb.Append(",\"engine\":\"unity\",\"engineVersion\":").Append(Json.Str(Application.unityVersion));
            sb.Append(",\"sdk\":").Append(Json.Str("com.hawkes.playtest@" + PackageVersion));
            sb.Append(",\"platform\":").Append(Json.Str(PlatformName()));
            sb.Append(",\"ready\":").Append(IsReady ? "true" : "false");
            return sb.Append('}').ToString();
        }

        static string PlatformName()
        {
            switch (Application.platform)
            {
                case RuntimePlatform.WindowsPlayer:
                case RuntimePlatform.WindowsEditor: return "windows";
                case RuntimePlatform.LinuxPlayer:
                case RuntimePlatform.LinuxEditor: return "linux";
                case RuntimePlatform.OSXPlayer:
                case RuntimePlatform.OSXEditor: return "macos";
                default: return Application.platform.ToString().ToLowerInvariant();
            }
        }
    }

    /// <summary>
    /// The socket: a ClientWebSocket on one background thread, with a queue each way. Send and TryReceive are safe
    /// from any thread; nothing here touches Unity.
    /// </summary>
    sealed class NativeLink
    {
        const int MaxMessage = 1024 * 1024;
        const int LogsPerSecond = 200;

        readonly Uri _uri;
        readonly ConcurrentQueue<string> _inbox = new ConcurrentQueue<string>();
        readonly ConcurrentQueue<string> _outbox = new ConcurrentQueue<string>();
        readonly SemaphoreSlim _outSignal = new SemaphoreSlim(0);
        readonly CancellationTokenSource _cts = new CancellationTokenSource();
        readonly object _logLock = new object();
        Thread _thread;
        ClientWebSocket _ws;
        volatile int _status; // 0 connecting, 1 open, 2 ended
        volatile bool _closing;
        long _logSecond;
        int _logCount;
        int _logDropped;

        public string Error { get; private set; } = "";
        public bool IsOpen => _status == 1 && !_closing;
        public bool IsEnded => _status == 2;

        public NativeLink(Uri uri) { _uri = uri; }

        public void Start()
        {
            _thread = new Thread(Run) { IsBackground = true, Name = "HawkesPlaytest" };
            _thread.Start();
        }

        public void Send(string json)
        {
            if (_status == 2 || _closing) return;
            _outbox.Enqueue(json);
            _outSignal.Release();
        }

        public bool TryReceive(out string text) => _inbox.TryDequeue(out text);

        public void SendLog(string level, string line)
        {
            int dropped = 0;
            lock (_logLock)
            {
                var second = DateTime.UtcNow.Ticks / TimeSpan.TicksPerSecond;
                if (second != _logSecond)
                {
                    dropped = _logDropped;
                    _logSecond = second;
                    _logCount = 0;
                    _logDropped = 0;
                }
                if (_logCount >= LogsPerSecond)
                {
                    _logDropped++;
                    return;
                }
                _logCount++;
            }
            if (dropped > 0) Send("{\"type\":\"log\",\"level\":\"warning\",\"line\":" + Json.Str(dropped + " log lines dropped (over " + LogsPerSecond + " a second)") + "}");
            Send("{\"type\":\"log\",\"level\":\"" + level + "\",\"line\":" + Json.Str(line) + "}");
        }

        /// <summary>Sends what's queued, closes with 1000, and waits up to waitMs for the thread.</summary>
        public void Close(int waitMs)
        {
            if (_status == 2 || _closing) return;
            _closing = true;
            _outSignal.Release();
            if (_thread != null && Thread.CurrentThread != _thread) _thread.Join(waitMs);
            _cts.Cancel();
        }

        void Run()
        {
            try { RunAsync().GetAwaiter().GetResult(); }
            catch (Exception e) { if (string.IsNullOrEmpty(Error)) Error = e.GetBaseException().Message; }
            finally
            {
                _status = 2;
                try { _ws?.Dispose(); } catch { }
            }
        }

        async Task RunAsync()
        {
            // The runner listens before it launches us, so the first try normally works; retry for up to 10 s.
            var deadline = DateTime.UtcNow.AddSeconds(10);
            for (;;)
            {
                _ws = new ClientWebSocket();
                _ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                try
                {
                    await _ws.ConnectAsync(_uri, _cts.Token).ConfigureAwait(false);
                    break;
                }
                catch (Exception e)
                {
                    try { _ws.Dispose(); } catch { }
                    _ws = null;
                    Error = e.GetBaseException().Message;
                    if (_closing || DateTime.UtcNow > deadline) return;
                    await Task.Delay(250).ConfigureAwait(false);
                }
            }
            _status = 1;
            var receive = ReceiveLoop();
            var send = SendLoop();
            await Task.WhenAny(receive, send).ConfigureAwait(false);
            _cts.Cancel();
            try { await Task.WhenAll(receive, send).ConfigureAwait(false); } catch { }
        }

        async Task SendLoop()
        {
            try
            {
                while (_ws.State == WebSocketState.Open)
                {
                    string json;
                    while (_outbox.TryDequeue(out json))
                    {
                        var bytes = Encoding.UTF8.GetBytes(json);
                        if (bytes.Length > MaxMessage) continue; // over the spec's limit: never sent
                        await _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts.Token).ConfigureAwait(false);
                    }
                    if (_closing)
                    {
                        using (var t = new CancellationTokenSource(400))
                            await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", t.Token).ConfigureAwait(false);
                        return;
                    }
                    await _outSignal.WaitAsync(_cts.Token).ConfigureAwait(false);
                }
            }
            catch (Exception e)
            {
                if (!_closing && string.IsNullOrEmpty(Error)) Error = e.GetBaseException().Message;
            }
        }

        async Task ReceiveLoop()
        {
            var buffer = new byte[16 * 1024];
            var message = new MemoryStream();
            try
            {
                while (_ws.State == WebSocketState.Open || _ws.State == WebSocketState.CloseSent)
                {
                    var r = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token).ConfigureAwait(false);
                    if (r.MessageType == WebSocketMessageType.Close)
                    {
                        Error = "closed by the runner (" + (int)(r.CloseStatus ?? WebSocketCloseStatus.Empty) + " " + r.CloseStatusDescription + ")";
                        if (_ws.State == WebSocketState.CloseReceived)
                        {
                            using (var t = new CancellationTokenSource(400))
                                await _ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "", t.Token).ConfigureAwait(false);
                        }
                        return;
                    }
                    if (message.Length + r.Count <= MaxMessage) message.Write(buffer, 0, r.Count);
                    else message.SetLength(MaxMessage + 1); // too big: dropped when it ends
                    if (!r.EndOfMessage) continue;
                    if (r.MessageType == WebSocketMessageType.Text && message.Length <= MaxMessage)
                        _inbox.Enqueue(Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length));
                    message.SetLength(0);
                }
            }
            catch (Exception e)
            {
                if (!_closing && string.IsNullOrEmpty(Error)) Error = e.GetBaseException().Message;
            }
        }
    }

    /// <summary>Just enough JSON for the runner's messages: objects, arrays, strings, numbers, booleans, null.</summary>
    static class MiniJson
    {
        public static object Parse(string text)
        {
            var i = 0;
            var v = Value(text, ref i);
            Skip(text, ref i);
            if (i != text.Length) throw new FormatException("trailing characters");
            return v;
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) ? v as string : null;
        }

        public static double? Num(Dictionary<string, object> d, string key)
        {
            object v;
            if (d.TryGetValue(key, out v) && v is double) return (double)v;
            return null;
        }

        public static long? Long(Dictionary<string, object> d, string key)
        {
            var n = Num(d, key);
            return n.HasValue ? (long?)Math.Round(n.Value) : null;
        }

        public static string Write(object v)
        {
            var sb = new StringBuilder();
            Write(sb, v);
            return sb.ToString();
        }

        static void Write(StringBuilder sb, object v)
        {
            if (v == null) sb.Append("null");
            else if (v is string) sb.Append(Json.Str((string)v));
            else if (v is bool) sb.Append((bool)v ? "true" : "false");
            else if (v is double) sb.Append(((double)v).ToString("R", CultureInfo.InvariantCulture));
            else if (v is Dictionary<string, object>)
            {
                sb.Append('{');
                var first = true;
                foreach (var kv in (Dictionary<string, object>)v)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(Json.Str(kv.Key)).Append(':');
                    Write(sb, kv.Value);
                }
                sb.Append('}');
            }
            else if (v is List<object>)
            {
                sb.Append('[');
                var list = (List<object>)v;
                for (var i = 0; i < list.Count; i++)
                {
                    if (i > 0) sb.Append(',');
                    Write(sb, list[i]);
                }
                sb.Append(']');
            }
            else sb.Append("null");
        }

        static void Skip(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        static object Value(string s, ref int i)
        {
            Skip(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end");
            var c = s[i];
            if (c == '{') return Obj(s, ref i);
            if (c == '[') return Arr(s, ref i);
            if (c == '"') return Text(s, ref i);
            if (c == 't' && string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (c == 'f' && string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (c == 'n' && string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
            return Number(s, ref i);
        }

        static Dictionary<string, object> Obj(string s, ref int i)
        {
            var d = new Dictionary<string, object>();
            i++;
            Skip(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return d; }
            for (;;)
            {
                Skip(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("expected a key");
                var key = Text(s, ref i);
                Skip(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':'");
                i++;
                d[key] = Value(s, ref i);
                Skip(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; return d; }
                throw new FormatException("expected ',' or '}'");
            }
        }

        static List<object> Arr(string s, ref int i)
        {
            var list = new List<object>();
            i++;
            Skip(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return list; }
            for (;;)
            {
                list.Add(Value(s, ref i));
                Skip(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == ']') { i++; return list; }
                throw new FormatException("expected ',' or ']'");
            }
        }

        static string Text(string s, ref int i)
        {
            i++; // opening quote
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                var c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                var e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("bad \\u escape");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
            throw new FormatException("unterminated string");
        }

        static double Number(string s, ref int i)
        {
            var start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (i == start) throw new FormatException("unexpected character '" + s[start] + "'");
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }
    }
}
#endif
