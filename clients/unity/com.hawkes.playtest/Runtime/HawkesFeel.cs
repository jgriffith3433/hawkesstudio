// The playtest "feel" sensor for Unity (hawkesstudio/docs/playtest.md#feel): the same checks as
// clients/web/hawkes-feel.js, measured while a playtest runs, nothing at all otherwise.
//
//   camera-snap, camera-jump, camera-blocked, below-ground, fell-out, stuck, collision-pop, jitter, hitch,
//   foot-sliding (set AnimSpeed), slope-slide (set Grounded)
//
// Add it once (any GameObject), and tell it who the player is:
//   var feel = gameObject.AddComponent<HawkesFeel>();
//   feel.Player = hero.transform;                 // the camera defaults to Camera.main
//   feel.Input = () => moveAction.ReadValue<Vector2>().magnitude;   // movement input held, 0..1
// Before a teleport, respawn or cutscene: HawkesFeel.Cut().
// Each flag goes into the run (event "feel", a problem for bugs, the report's "feel") and, on WebGL, is pushed to the
// runner at once (window.__hawkesPlaytestPush); on desktop it travels as the run event.
// While the player can't move (a cutscene, a menu, the game playing itself) set Active to return false: only hitches count.
// To replay a flagged place, the bot reads options.spot ("x,y,z[,yaw]": HawkesFeel.ParseSpot), stands the player there,
// calls HawkesFeel.Cut() and plays on with real input.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

namespace Hawkes.Playtest
{
    [DisallowMultipleComponent]
    public sealed class HawkesFeel : MonoBehaviour
    {
        public Transform Player;
        public Camera Camera;
        /// <summary>Movement input held, 0..1. Default: WASD / arrows held (legacy input manager), else 0.</summary>
        public Func<float> Input;
        /// <summary>The layers that count as floor and walls for the rays (default: everything but the player's own).</summary>
        public LayerMask Solid = ~0;
        /// <summary>The controller's grounded flag (CharacterController.isGrounded): turns on the slope-landing check.</summary>
        public Func<bool> Grounded;
        /// <summary>How fast the walk/run animation moves the feet, m/s (0 idle): turns on the foot-sliding check.</summary>
        public Func<float> AnimSpeed;
        /// <summary>False while the player can't move (cutscene, menu, the game playing itself): only hitches count then.</summary>
        public Func<bool> Active;
        /// <summary>Eye height above Player.position (a feet pivot: about 1.5; a capsule-centre pivot: about 0.7).</summary>
        public float HeadHeight = 1.5f;

        [Header("Thresholds")]
        public float SnapDegPerSec = 540f, SnapMinDeg = 25f, CameraJumpMeters = 3f, BelowGroundMeters = 0.5f,
            FellOutSeconds = 2f, KillY = -200f, StuckSeconds = 1.5f, StuckMeters = 0.25f, PopMeters = 2f,
            HitchMs = 100f, HitchFactor = 4f, BlockedSeconds = 0.4f, MergeMeters = 3f, MergeSeconds = 5f,
            SlideMetersPerSec = 1.5f, SlideSeconds = 0.5f, LandSlideMeters = 1f, LandSeconds = 0.6f;
        public int JitterFlips = 6, MaxFlags = 200, RayEvery = 4;

        static HawkesFeel _instance;

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern void HawkesPlaytest_Push(string json);
#endif

        sealed class Flag
        {
            public string Id, Kind, Severity, Detail, Scene; public float T, LastT, Value; public Vector3? Pos; public Vector3 CamPos;
            public float Yaw, Pitch; public bool HasCam; public int Count = 1, Seed;
        }

        PlaytestRun _run;
        readonly List<Flag> _flags = new List<Flag>();
        readonly List<float> _dts = new List<float>();
        readonly List<(float t, Vector3 pos, float input)> _moves = new List<(float, Vector3, float)>();
        readonly List<float> _flips = new List<float>();
        bool _hasPrev, _hasCamPrev = false, _wasActive = true; float _prevT; Vector3 _prevCamPos, _prevCamFwd, _prevPlayer; bool _prevHasPlayer;
        float _quietUntil = -1, _t0;
        float? _fallingSince, _blockedSince, _belowSince, _slidingSince, _landedT;
        Vector3 _landedPos; bool? _wasGrounded;
        int _lastSignX, _lastSignZ, _frame, _n;

        void OnEnable() => _instance = this;
        void OnDisable() { if (_instance == this) _instance = null; }

        /// <summary>An intended cut, respawn or teleport: camera and movement checks rest for a moment.</summary>
        public static void Cut(float seconds = 0.75f)
        {
            var f = _instance;
            if (f == null) return;
            // A bot that teleports in the run's first frame calls this before Update has seen the run: start it now so
            // the quiet time isn't wiped by Begin.
            var run = HawkesPlaytest.Current;
            if (run != null && !run.Done && run != f._run) f.Begin(run);
            f._quietUntil = f.Now + seconds;
            f._fallingSince = null; f._belowSince = null; f._slidingSince = null; f._landedT = null; f._moves.Clear(); f._flips.Clear();
        }

        /// <summary>"x,y,z[,yaw]" (options.spot) as a position and yaw (NaN when absent); false when it isn't one.</summary>
        public static bool ParseSpot(string spot, out Vector3 pos, out float yaw)
        {
            pos = default; yaw = float.NaN;
            if (string.IsNullOrEmpty(spot)) return false;
            var parts = spot.Split(',');
            if (parts.Length < 3) return false;
            var v = new float[3];
            for (var i = 0; i < 3; i++)
                if (!float.TryParse(parts[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v[i])) return false;
            pos = new Vector3(v[0], v[1], v[2]);
            if (parts.Length > 3 && float.TryParse(parts[3].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var y)) yaw = y;
            return true;
        }

        float Now => Time.realtimeSinceStartup - _t0;

        void Update()
        {
            var run = HawkesPlaytest.Current;
            if (run == null || run.Done) { if (_run != null) _run = null; return; }
            if (run != _run) Begin(run);
            Sample(Time.unscaledDeltaTime);
        }

        void Begin(PlaytestRun run)
        {
            _run = run; _flags.Clear(); _dts.Clear(); _moves.Clear(); _flips.Clear();
            _hasPrev = false; _hasCamPrev = false; _prevHasPlayer = false; _wasActive = true; _quietUntil = -1; _t0 = Time.realtimeSinceStartup; _frame = 0; _n = 0;
            _fallingSince = _blockedSince = _belowSince = _slidingSince = _landedT = null; _wasGrounded = null; _lastSignX = _lastSignZ = 0;
        }

        float Median()
        {
            if (_dts.Count == 0) return 1f / 60f;
            var s = new List<float>(_dts); s.Sort();
            return s[s.Count / 2];
        }

        float ReadInput()
        {
            if (Input != null) { try { return Input(); } catch { return 0; } }
#if ENABLE_LEGACY_INPUT_MANAGER
            try { return Mathf.Clamp01(new Vector2(UnityEngine.Input.GetAxisRaw("Horizontal"), UnityEngine.Input.GetAxisRaw("Vertical")).magnitude); } catch { }
#endif
            return 0;
        }

        bool Ray(Vector3 from, Vector3 dir, float len, out RaycastHit hit)
        {
            var hits = Physics.RaycastAll(from, dir, len, Solid, QueryTriggerInteraction.Ignore);
            hit = default; var best = float.MaxValue; var found = false;
            foreach (var h in hits)
            {
                if (Player != null && h.transform.IsChildOf(Player)) continue;
                if (h.distance < best) { best = h.distance; hit = h; found = true; }
            }
            return found;
        }

        void Sample(float dt)
        {
            var t = Now;
            _frame++;
            var med = Median();
            var quiet = t < _quietUntil;
            var cam = Camera != null ? Camera : Camera.main;

            if (_hasPrev && dt * 1000f >= HitchMs && dt >= med * HitchFactor)
                Raise("hitch", t, Mathf.Round(dt * 1000f), "frame took " + Mathf.RoundToInt(dt * 1000f) + " ms (usual " + Mathf.RoundToInt(med * 1000f) + " ms)", cam);
            if (dt > 0 && dt < 1) { _dts.Add(dt); if (_dts.Count > 120) _dts.RemoveAt(0); }

            var active = true;
            if (Active != null) { try { active = Active(); } catch { active = true; } }
            if (active && !_wasActive) Cut();
            _wasActive = active;
            if (!active)
            {
                // Only hitches while inactive; everything else starts fresh when control comes back.
                _hasCamPrev = false; _prevHasPlayer = false;
                _fallingSince = _blockedSince = _belowSince = _slidingSince = _landedT = null; _wasGrounded = null;
                _moves.Clear(); _flips.Clear();
                _hasPrev = true; _prevT = t;
                return;
            }

            var hasPlayer = Player != null;
            var p = hasPlayer ? Player.position : Vector3.zero;

            if (cam != null)
            {
                var cpos = cam.transform.position; var cfwd = cam.transform.forward;
                if (_hasCamPrev && !quiet && dt > 0 && dt < 0.5f)
                {
                    var turned = Vector3.Angle(_prevCamFwd, cfwd);
                    if (turned >= SnapMinDeg && turned / Mathf.Max(dt, med) >= SnapDegPerSec) Raise("camera-snap", t, turned, "camera turned " + Mathf.RoundToInt(turned) + "° in one frame", cam);
                    var moved = Vector3.Distance(_prevCamPos, cpos) - (hasPlayer && _prevHasPlayer ? Vector3.Distance(_prevPlayer, p) : 0);
                    if (moved >= CameraJumpMeters) Raise("camera-jump", t, moved, "camera moved " + moved.ToString("0.0", CultureInfo.InvariantCulture) + " m in one frame", cam);
                }
                if (hasPlayer && _frame % RayEvery == 0)
                {
                    var eye = p + Vector3.up * HeadHeight; var to = cpos - eye; var len = to.magnitude;
                    if (len > 0.5f)
                    {
                        var blocked = Ray(eye, to / len, len, out var hit) && hit.distance < len - 0.3f;
                        if (blocked) { _blockedSince ??= t; if (t - _blockedSince >= BlockedSeconds) Raise("camera-blocked", t, t - _blockedSince.Value, "camera behind geometry", cam); }
                        else _blockedSince = null;
                    }
                }
                _prevCamPos = cpos; _prevCamFwd = cfwd; _hasCamPrev = true;
            }

            if (hasPlayer)
            {
                if (_frame % RayEvery == 0)
                {
                    var floorBelow = Ray(p + Vector3.up * 0.3f, Vector3.down, 500, out _);
                    float? above = Ray(p + Vector3.up * 60, Vector3.down, 60, out var top) && top.point.y > p.y + 0.31f ? top.point.y : (float?)null;
                    if (!floorBelow && above.HasValue && above.Value - p.y >= BelowGroundMeters)
                    { _belowSince ??= t; if (t - _belowSince >= 0.25f) Raise("below-ground", t, above.Value - p.y, "player " + (above.Value - p.y).ToString("0.0", CultureInfo.InvariantCulture) + " m under the surface above them", cam); }
                    else _belowSince = null;
                    if (!floorBelow && !above.HasValue && _prevHasPlayer && p.y < _prevPlayer.y) { _fallingSince ??= t; if (t - _fallingSince >= FellOutSeconds) Raise("fell-out", t, p.y, "player fell out of the world", cam); }
                    else if (floorBelow) _fallingSince = null;
                }
                if (p.y < KillY) Raise("fell-out", t, p.y, "player at height " + p.y.ToString("0.0", CultureInfo.InvariantCulture), cam);

                if (_prevHasPlayer && !quiet && dt > 0 && dt < 0.5f)
                {
                    var step = Vector3.Distance(_prevPlayer, p);
                    float speed = 0; var first = -1;
                    for (var i = 0; i < _moves.Count; i++) if (t - _moves[i].t <= 1) { first = i; break; }
                    if (first >= 0 && _moves.Count - first > 1)
                    {
                        var a = _moves[first]; var b = _moves[_moves.Count - 1];
                        speed = Vector3.Distance(a.pos, b.pos) / Mathf.Max(0.05f, b.t - a.t);
                    }
                    if (step >= PopMeters && step >= speed * dt * 4 + PopMeters * 0.5f) Raise("collision-pop", t, step, "player moved " + step.ToString("0.0", CultureInfo.InvariantCulture) + " m in one frame", cam);
                    var vx = (p.x - _prevPlayer.x) / dt; var vz = (p.z - _prevPlayer.z) / dt;
                    Flip(ref _lastSignX, vx, t); Flip(ref _lastSignZ, vz, t);
                    while (_flips.Count > 0 && t - _flips[0] > 1) _flips.RemoveAt(0);
                    if (_flips.Count >= JitterFlips) { Raise("jitter", t, _flips.Count, _flips.Count + " direction flips in a second", cam); _flips.Clear(); }
                }

                var input = ReadInput();
                bool? grounded = null;
                if (Grounded != null) { try { grounded = Grounded(); } catch { } }
                if (AnimSpeed != null && grounded != false && _prevHasPlayer && dt > 0 && dt < 0.5f && !quiet)
                {
                    float anim = 0; try { anim = AnimSpeed(); } catch { }
                    var body = new Vector2(p.x - _prevPlayer.x, p.z - _prevPlayer.z).magnitude / dt;
                    if (Mathf.Abs(body - anim) >= SlideMetersPerSec) { _slidingSince ??= t; if (t - _slidingSince >= SlideSeconds) Raise("foot-sliding", t, body - anim, "body moves " + body.ToString("0.0", CultureInfo.InvariantCulture) + " m/s, feet animate " + anim.ToString("0.0", CultureInfo.InvariantCulture) + " m/s", cam); }
                    else _slidingSince = null;
                }
                if (grounded.HasValue)
                {
                    if (grounded.Value && _wasGrounded == false) { _landedT = t; _landedPos = p; }
                    _wasGrounded = grounded.Value;
                    if (_landedT.HasValue && input >= 0.5f) _landedT = null;
                    if (_landedT.HasValue)
                    {
                        var slid = new Vector2(p.x - _landedPos.x, p.z - _landedPos.z).magnitude;
                        if (t - _landedT.Value > LandSeconds) _landedT = null;
                        else if (slid >= LandSlideMeters && !quiet) { Raise("slope-slide", t, slid, "slid " + slid.ToString("0.0", CultureInfo.InvariantCulture) + " m after landing, no input", cam); _landedT = null; }
                    }
                }
                _moves.Add((t, p, input));
                var keep = Mathf.Max(3, StuckSeconds + 0.5f);
                while (_moves.Count > 0 && t - _moves[0].t > keep) _moves.RemoveAt(0);
                if (input >= 0.5f && !quiet)
                {
                    var start = -1; var held = true;
                    for (var i = 0; i < _moves.Count; i++)
                    {
                        if (t - _moves[i].t > StuckSeconds) continue;
                        if (start < 0) start = i;
                        if (_moves[i].input < 0.5f) held = false;
                    }
                    if (start >= 0 && held && _moves.Count - start > 2 && t - _moves[start].t >= StuckSeconds * 0.9f)
                    {
                        var s0 = _moves[start].pos; var flat = new Vector2(p.x - s0.x, p.z - s0.z).magnitude;
                        if (flat < StuckMeters) Raise("stuck", t, StuckSeconds, "movement held " + StuckSeconds.ToString("0.0", CultureInfo.InvariantCulture) + " s, moved " + flat.ToString("0.00", CultureInfo.InvariantCulture) + " m", cam);
                    }
                }
                _prevPlayer = p;
            }
            _prevHasPlayer = hasPlayer;
            _hasPrev = true; _prevT = t;
        }

        void Flip(ref int last, float v, float t)
        {
            if (Mathf.Abs(v) < 0.5f) return;
            var sign = v > 0 ? 1 : -1;
            if (last != 0 && sign != last) _flips.Add(t);
            last = sign;
        }

        static string Sev(string kind) => kind == "below-ground" || kind == "fell-out" || kind == "inside-geometry" || kind == "stuck" ? "bug" : "polish";

        void Raise(string kind, float t, float value, string detail, Camera cam)
        {
            Vector3? pos = Player != null ? Player.position : cam != null ? cam.transform.position : (Vector3?)null;
            for (var i = 0; i < _flags.Count; i++)
            {
                var f = _flags[i];
                if (f.Kind != kind || t - f.LastT > MergeSeconds) continue;
                if (pos.HasValue && f.Pos.HasValue && Vector3.Distance(pos.Value, f.Pos.Value) > MergeMeters) continue;
                f.Count++; f.LastT = t; if (Mathf.Abs(value) > Mathf.Abs(f.Value)) f.Value = value;
                _run.Feel[i] = FlagJson(f);
                return;
            }
            if (_flags.Count >= MaxFlags) return;
            var flag = new Flag
            {
                Id = "feel-" + (++_n), Kind = kind, Severity = Sev(kind), T = t, LastT = t, Value = value, Detail = detail, Pos = pos,
                Scene = _run.CurrentScene, Seed = _run.Options?.seed ?? 0,
            };
            if (cam != null)
            {
                var fwd = cam.transform.forward;
                flag.HasCam = true; flag.CamPos = cam.transform.position;
                flag.Yaw = Mathf.Atan2(fwd.x, fwd.z) * Mathf.Rad2Deg; flag.Pitch = Mathf.Asin(Mathf.Clamp(fwd.y, -1, 1)) * Mathf.Rad2Deg;
            }
            _flags.Add(flag);
            var json = FlagJson(flag);
            _run.Feel.Add(json);
            _run.Event("feel", "{\"id\":" + Q(flag.Id) + ",\"kind\":" + Q(kind) + ",\"pos\":" + V(pos) + ",\"seed\":" + flag.Seed + "}");
            if (flag.Severity == "bug") _run.Problem(PlaytestSeverity.Bug, detail + " at " + (pos.HasValue ? V(pos).Trim('[', ']') : "?") + (flag.Scene != null ? " (" + flag.Scene + ")" : ""));
#if UNITY_WEBGL && !UNITY_EDITOR
            try { HawkesPlaytest_Push("{\"type\":\"feel\",\"flag\":" + json + "}"); } catch { }
#endif
        }

        static string N(float v) => (Mathf.Round(v * 100) / 100).ToString(CultureInfo.InvariantCulture);
        static string Q(string s) => Json.Str(s);
        static string V(Vector3? v) => v.HasValue ? "[" + N(v.Value.x) + "," + N(v.Value.y) + "," + N(v.Value.z) + "]" : "null";

        static string FlagJson(Flag f)
        {
            var sb = new StringBuilder(256);
            sb.Append("{\"id\":").Append(Q(f.Id)).Append(",\"kind\":").Append(Q(f.Kind)).Append(",\"severity\":").Append(Q(f.Severity))
              .Append(",\"t\":").Append(N(f.T)).Append(",\"pos\":").Append(V(f.Pos));
            if (f.HasCam) sb.Append(",\"cam\":{\"pos\":").Append(V(f.CamPos)).Append(",\"yaw\":").Append(N(f.Yaw)).Append(",\"pitch\":").Append(N(f.Pitch)).Append('}');
            sb.Append(",\"seed\":").Append(f.Seed);
            if (f.Scene != null) sb.Append(",\"scene\":").Append(Q(f.Scene));
            sb.Append(",\"value\":").Append(N(f.Value)).Append(",\"detail\":").Append(Q(f.Detail)).Append(",\"count\":").Append(f.Count).Append('}');
            return sb.ToString();
        }
    }
}
