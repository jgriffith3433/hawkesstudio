// The Hawkes playtest contract v1 for Unity games (spec: C:/Projects/hawkesstudio/docs/playtest.md).
//
// At startup, register the scenarios and a bot coroutine that plays through real input:
//
//   HawkesPlaytest.Register("sickofit", new[] {
//       new PlaytestScenario("smoke", "Boot, menu, first level for 30 s", 45, "smoke"),
//       new PlaytestScenario("level-1", "Play level 1 to the end", 120, "full"),
//   }, Bot, isReady: () => GameBoot.Ready);
//
//   static IEnumerator Bot(string id, PlaytestOptions options, PlaytestRun run) {
//       run.Scene("Main Menu");
//       yield return MenuBot.PressPlay();
//       run.Event("level-start", "1");
//       ...
//       run.Add("deaths");
//       run.Progress(0.5f);
//       run.Finish(PlaytestOutcome.Won);
//   }
//
// In a WebGL build the browser sees window.hawkesPlaytest (the Hawkes Studio runner drives it; ?playtest=<id> in
// the URL starts one). In the editor and in PlayMode tests, call HawkesPlaytest.StartScenario directly.
// Nothing runs and nothing is created until Register is called.

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace Hawkes.Playtest
{
    public enum PlaytestOutcome { Won, Lost, Done, Stuck, Error }

    public enum PlaytestSeverity { Bug, Warning, Polish }

    [Serializable]
    public class PlaytestScenario
    {
        public string id;
        public string title;
        public float seconds;
        public string[] tags;

        public PlaytestScenario() { }

        public PlaytestScenario(string id, string title, float seconds, params string[] tags)
        {
            this.id = id;
            this.title = title;
            this.seconds = seconds;
            this.tags = tags;
        }
    }

    public class PlaytestOptions
    {
        public int seed = 1;
        public float speed = 1f;
    }

    public delegate IEnumerator PlaytestBot(string scenario, PlaytestOptions options, PlaytestRun run);

    /// <summary>One playtest in progress: the bot reports through it.</summary>
    public sealed class PlaytestRun
    {
        public readonly string Scenario;
        public readonly PlaytestOptions Options;
        public readonly float StartTime;
        public bool Done { get; private set; }
        public PlaytestOutcome Outcome { get; private set; } = PlaytestOutcome.Done;
        public string CurrentScene { get; private set; }
        public float CurrentProgress { get; private set; }
        public string CurrentNote { get; private set; }
        public float Seconds => Done ? _endTime - StartTime : Time.realtimeSinceStartup - StartTime;

        internal readonly Dictionary<string, double> Metrics = new Dictionary<string, double>();
        internal readonly List<(float t, string type, string detail)> Events = new List<(float, string, string)>();
        internal readonly List<(PlaytestSeverity severity, string message)> Problems = new List<(PlaytestSeverity, string)>();
        internal readonly List<string> LogLines = new List<string>();
        internal float LastMove;
        float _endTime;

        internal PlaytestRun(string scenario, PlaytestOptions options)
        {
            Scenario = scenario;
            Options = options;
            StartTime = Time.realtimeSinceStartup;
            LastMove = StartTime;
        }

        float T => Time.realtimeSinceStartup - StartTime;

        void Moved() => LastMove = Time.realtimeSinceStartup;

        public void Scene(string name)
        {
            if (CurrentScene == name) return;
            CurrentScene = name;
            Event("scene", name);
        }

        public void Progress(float progress)
        {
            CurrentProgress = Mathf.Clamp01(progress);
            Moved();
        }

        public void Note(string text) => CurrentNote = text;

        /// <summary>A reading (hp, fps, size). Unlike Progress, Add and Event it doesn't count as progress for the softlock check.</summary>
        public void Metric(string name, double value)
        {
            Metrics[name] = value;
        }

        public void Add(string name, double amount = 1)
        {
            Metrics.TryGetValue(name, out var v);
            Metrics[name] = v + amount;
            Moved();
        }

        public void Event(string type, string detail = null)
        {
            if (Done) return;
            Events.Add((T, type, detail));
            if (Events.Count > 2000) Events.RemoveRange(0, Events.Count - 2000);
            Moved();
        }

        public void Problem(PlaytestSeverity severity, string message)
        {
            foreach (var p in Problems)
                if (p.message == message) return;
            Problems.Add((severity, message));
            Event("problem", severity.ToString().ToLowerInvariant() + ": " + message);
        }

        public void Log(string line)
        {
            LogLines.Add(T.ToString("0.0", CultureInfo.InvariantCulture) + "s " + line);
            if (LogLines.Count > 200) LogLines.RemoveAt(0);
        }

        public void Finish(PlaytestOutcome outcome = PlaytestOutcome.Done)
        {
            if (Done) return;
            Event("finish", outcome.ToString().ToLowerInvariant());
            Outcome = outcome;
            Done = true;
            _endTime = Time.realtimeSinceStartup;
            HawkesPlaytest.OnFinished(this);
        }

        /// <summary>Waits until test() is true; finishes the run as Stuck after timeout seconds (real time).</summary>
        public IEnumerator Until(Func<bool> test, float timeout, string what)
        {
            var end = Time.realtimeSinceStartup + timeout;
            while (!Done)
            {
                bool ok;
                try { ok = test(); }
                catch { ok = false; }
                if (ok) yield break;
                if (Time.realtimeSinceStartup > end)
                {
                    Problem(PlaytestSeverity.Bug, "timed out waiting for " + what);
                    Finish(PlaytestOutcome.Stuck);
                    yield break;
                }
                yield return null;
            }
        }

        /// <summary>The game's frame rate, measured by the driver (unscaled time).</summary>
        internal float Fps;

        internal string StateJson(bool ready)
        {
            var sb = new StringBuilder(256);
            sb.Append("{\"ready\":").Append(ready ? "true" : "false");
            if (Fps > 0) sb.Append(",\"fps\":").Append(Json.Num(Mathf.Round(Fps)));
            sb.Append(",\"status\":").Append(Json.Str(Done ? Outcome.ToString().ToLowerInvariant() : "running"));
            if (CurrentScene != null) sb.Append(",\"scene\":").Append(Json.Str(CurrentScene));
            sb.Append(",\"progress\":").Append(Json.Num(CurrentProgress));
            if (CurrentNote != null) sb.Append(",\"note\":").Append(Json.Str(CurrentNote));
            sb.Append(",\"metrics\":");
            Json.Dict(sb, Metrics);
            sb.Append('}');
            return sb.ToString();
        }

        internal string ReportJson()
        {
            var sb = new StringBuilder(4096);
            sb.Append("{\"scenario\":").Append(Json.Str(Scenario));
            sb.Append(",\"outcome\":").Append(Json.Str(Done ? Outcome.ToString().ToLowerInvariant() : "stuck"));
            sb.Append(",\"seconds\":").Append(Json.Num(Seconds));
            sb.Append(",\"metrics\":");
            Json.Dict(sb, Metrics);
            sb.Append(",\"events\":[");
            for (var i = 0; i < Events.Count; i++)
            {
                var e = Events[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"t\":").Append(Json.Num(e.t)).Append(",\"type\":").Append(Json.Str(e.type));
                if (e.detail != null) sb.Append(",\"detail\":").Append(Json.Str(e.detail));
                sb.Append('}');
            }
            sb.Append("],\"problems\":[");
            for (var i = 0; i < Problems.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"severity\":").Append(Json.Str(Problems[i].severity.ToString().ToLowerInvariant()))
                  .Append(",\"message\":").Append(Json.Str(Problems[i].message)).Append('}');
            }
            sb.Append("],\"log\":[");
            for (var i = 0; i < LogLines.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(Json.Str(LogLines[i]));
            }
            sb.Append("]}");
            return sb.ToString();
        }
    }

    public static class HawkesPlaytest
    {
        public const int ContractVersion = 1;

        public static string Product { get; private set; }
        public static IReadOnlyList<PlaytestScenario> Scenarios => _scenarios;
        public static PlaytestRun Current { get; private set; }
        public static bool Registered => _bot != null;

        /// <summary>Called when a run finishes (any outcome).</summary>
        public static event Action<PlaytestRun> Finished;

        static PlaytestScenario[] _scenarios = new PlaytestScenario[0];
        static PlaytestBot _bot;
        static Func<bool> _isReady;
        static Action _stop;
        static Action<string, bool> _input;
        static float _stallSeconds = 60f;
        static Driver _driver;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern void HawkesPlaytest_Install(string product, string scenariosJson);
        [DllImport("__Internal")] static extern string HawkesPlaytest_TakeCommand();
        [DllImport("__Internal")] static extern void HawkesPlaytest_SetState(string json);
        [DllImport("__Internal")] static extern void HawkesPlaytest_SetReport(string json);
#endif

        /// <summary>Registers the game's scenarios and bot. Call once at startup (calling again replaces them).</summary>
        public static void Register(string product, PlaytestScenario[] scenarios, PlaytestBot bot,
            Func<bool> isReady = null, Action stop = null, Action<string, bool> input = null, float stallSeconds = 60f)
        {
            Product = product;
            _scenarios = scenarios ?? new PlaytestScenario[0];
            _bot = bot ?? throw new ArgumentNullException(nameof(bot));
            _isReady = isReady;
            _stop = stop;
            _input = input;
            _stallSeconds = stallSeconds;
            EnsureDriver();
#if UNITY_WEBGL && !UNITY_EDITOR
            HawkesPlaytest_Install(product, ScenariosJson());
#endif
        }

        public static bool IsReady
        {
            get
            {
                if (_isReady == null) return true;
                try { return _isReady(); }
                catch { return false; }
            }
        }

        /// <summary>Starts a scenario now (from the browser bridge, the editor or a test). Stops any run in progress.</summary>
        public static PlaytestRun StartScenario(string id, PlaytestOptions options = null)
        {
            if (_bot == null) throw new InvalidOperationException("HawkesPlaytest.Register was not called");
            var known = false;
            foreach (var s in _scenarios)
                if (s.id == id) known = true;
            Stop();
            var run = new PlaytestRun(id, options ?? new PlaytestOptions());
            Current = run;
            if (!known)
            {
                run.Problem(PlaytestSeverity.Bug, "no playtest scenario \"" + id + "\"");
                run.Finish(PlaytestOutcome.Error);
                return run;
            }
            run.Event("start", id);
            EnsureDriver();
            _driver.Begin(run, _bot(id, run.Options, run));
            return run;
        }

        public static void Stop()
        {
            if (Current != null && !Current.Done) Current.Finish(PlaytestOutcome.Done);
            if (_driver != null) _driver.Halt();
            try { _stop?.Invoke(); }
            catch (Exception e) { Debug.LogException(e); }
        }

        internal static void OnFinished(PlaytestRun run)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            HawkesPlaytest_SetState(run.StateJson(IsReady));
            HawkesPlaytest_SetReport(run.ReportJson());
#endif
            try { Finished?.Invoke(run); }
            catch (Exception e) { Debug.LogException(e); }
        }

        /// <summary>The report JSON for a run (what the browser runner reads).</summary>
        public static string ReportJson(PlaytestRun run) => run.ReportJson();

        static string ScenariosJson()
        {
            var sb = new StringBuilder("[");
            for (var i = 0; i < _scenarios.Length; i++)
            {
                var s = _scenarios[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":").Append(Json.Str(s.id)).Append(",\"title\":").Append(Json.Str(s.title ?? s.id))
                  .Append(",\"seconds\":").Append(Json.Num(s.seconds)).Append(",\"tags\":[");
                var tags = s.tags ?? new string[0];
                for (var j = 0; j < tags.Length; j++)
                {
                    if (j > 0) sb.Append(',');
                    sb.Append(Json.Str(tags[j]));
                }
                sb.Append("]}");
            }
            return sb.Append(']').ToString();
        }

        static void EnsureDriver()
        {
            if (_driver != null) return;
            var go = new GameObject("HawkesPlaytest");
            UnityEngine.Object.DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideInHierarchy;
            _driver = go.AddComponent<Driver>();
        }

        [Serializable]
        class Command
        {
            public string cmd;
            public string id;
            public int seed = 1;
            public float speed = 1f;
            public string action;
            public bool down;
        }

        /// <summary>Runs the bot coroutine, polls browser commands, pushes state, and catches softlocks and errors.</summary>
        sealed class Driver : MonoBehaviour
        {
            Coroutine _routine;
            float _nextPush;

            void OnEnable() => Application.logMessageReceived += OnLog;
            void OnDisable() => Application.logMessageReceived -= OnLog;

            static void OnLog(string message, string stack, LogType type)
            {
                var run = Current;
                if (run == null || run.Done) return;
                if (type == LogType.Exception || type == LogType.Error || type == LogType.Assert)
                {
                    var first = message.Split('\n')[0];
                    run.Problem(PlaytestSeverity.Bug, (type == LogType.Exception ? "exception: " : "error: ") + first);
                    run.Log(first);
                }
            }

            public void Begin(PlaytestRun run, IEnumerator bot)
            {
                Halt();
                _routine = StartCoroutine(Wrap(run, bot));
            }

            public void Halt()
            {
                if (_routine != null) StopCoroutine(_routine);
                _routine = null;
            }

            static IEnumerator Wrap(PlaytestRun run, IEnumerator bot)
            {
                while (!run.Done)
                {
                    object current;
                    try
                    {
                        if (!bot.MoveNext()) break;
                        current = bot.Current;
                    }
                    catch (Exception e)
                    {
                        run.Problem(PlaytestSeverity.Bug, "bot error: " + e.Message);
                        run.Log(e.ToString());
                        run.Finish(PlaytestOutcome.Error);
                        yield break;
                    }
                    yield return current;
                }
                if (!run.Done) run.Finish(PlaytestOutcome.Done);
            }

            float _fpsTime;
            int _fpsFrames;

            void Update()
            {
                _fpsFrames++;
                _fpsTime += Time.unscaledDeltaTime;
                if (_fpsTime >= 1f)
                {
                    if (Current != null) Current.Fps = _fpsFrames / _fpsTime;
                    _fpsFrames = 0;
                    _fpsTime = 0f;
                }
#if UNITY_WEBGL && !UNITY_EDITOR
                string raw;
                while (!string.IsNullOrEmpty(raw = HawkesPlaytest_TakeCommand()))
                {
                    Command c;
                    try { c = JsonUtility.FromJson<Command>(raw); }
                    catch { continue; }
                    if (c.cmd == "start") StartScenario(c.id, new PlaytestOptions { seed = c.seed, speed = c.speed });
                    else if (c.cmd == "stop") Stop();
                    else if (c.cmd == "input") _input?.Invoke(c.action, c.down);
                }
#endif
                var run = Current;
                if (run == null) return;
                if (!run.Done && Time.realtimeSinceStartup - run.LastMove > _stallSeconds)
                {
                    run.Problem(PlaytestSeverity.Bug, "no progress for " + _stallSeconds.ToString("0", CultureInfo.InvariantCulture) + " s (softlock?)");
                    run.Finish(PlaytestOutcome.Stuck);
                    Halt();
                }
                if (Time.realtimeSinceStartup >= _nextPush)
                {
                    _nextPush = Time.realtimeSinceStartup + 0.5f;
#if UNITY_WEBGL && !UNITY_EDITOR
                    HawkesPlaytest_SetState(run.StateJson(IsReady));
                    if (!run.Done) HawkesPlaytest_SetReport(run.ReportJson());
#endif
                }
            }
        }
    }

    static class Json
    {
        public static string Num(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
            return Math.Round(v, 3).ToString(CultureInfo.InvariantCulture);
        }

        public static string Str(string s)
        {
            if (s == null) return "null";
            var sb = new StringBuilder(s.Length + 2).Append('"');
            foreach (var ch in s)
            {
                switch (ch)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
            return sb.Append('"').ToString();
        }

        public static void Dict(StringBuilder sb, Dictionary<string, double> d)
        {
            sb.Append('{');
            var first = true;
            foreach (var kv in d)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(Str(kv.Key)).Append(':').Append(Num(kv.Value));
            }
            sb.Append('}');
        }
    }
}
