// Hawkes UI kit for Unity: the twin of createUiKit in clients/web/hawkes-ui.js (spec: hawkesstudio/docs/playtest.md#ui-kit; the
// ui-kit skill). Menus that feel alive without each game rebuilding it: a pressed pop, hover and focus states, a ui-bus click
// (HawkesSound.PressUi) on every press, 150-200 ms screen slides (0 ms with reduced motion) and a safe-area container.
// It uses only RectTransform and CanvasGroup (no uGUI assembly), so call it from your buttons' handlers:
//
//   var ui = HawkesUI.Instance;                                  // one component on one GameObject (it finds HawkesSound itself)
//   playButton.onClick.AddListener(() => ui.Press((RectTransform)playButton.transform, "Play"));
//   ui.Fit((RectTransform)optionsButton.transform);              // grows a control to the 44 pt minimum
//   StartCoroutine(ui.Show(optionsScreen, menuScreen));          // slide: optionsScreen in, menuScreen out (dir -1 = back)
//   // on the menu's root panel: add HawkesSafeArea (keeps it out of the notch and home bar).
//
// Every Press logs exactly one "ui-press" (pressed state shown this frame, so visualMs is the frame time) and every Show one
// "ui-transition" to the playtest run, which the menus-and-ui check reads. Reduced motion: HawkesUI.ReducedMotion, set from the
// player's setting (PlayerPrefs "hawkes.reducedMotion"), the -reduced-motion argument, or "reduced-motion" in a WebGL page's URL.
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace Hawkes.Playtest
{
    public sealed class HawkesUI : MonoBehaviour
    {
        public const float MinTarget = 44f;
        public const float TransitionMin = 0.15f, TransitionMax = 0.20f, TransitionDefault = 0.18f;

        [Range(0.15f, 0.20f)] public float TransitionSeconds = TransitionDefault;
        public float PressScale = 0.95f, HoverScale = 1.04f, FocusScale = 1.06f, PressHold = 0.11f;
        public float SlideDistance = 28f;
        public HawkesSound Sound;

        static HawkesUI _instance;
        public static HawkesUI Instance
        {
            get
            {
                if (_instance == null) _instance = FindObjectOfType<HawkesUI>();
                if (_instance == null) _instance = new GameObject("HawkesUI").AddComponent<HawkesUI>();
                return _instance;
            }
        }

        static int _reduced = -1;
        /// <summary>The player asked for reduced motion: screens swap in 0 ms and presses don't scale.</summary>
        public static bool ReducedMotion
        {
            get
            {
                if (_reduced < 0)
                {
                    bool r = PlayerPrefs.GetInt("hawkes.reducedMotion", 0) == 1;
                    foreach (var a in System.Environment.GetCommandLineArgs()) if (a == "-reduced-motion") r = true;
                    var url = Application.absoluteURL;
                    if (!string.IsNullOrEmpty(url) && url.Contains("reduced-motion")) r = true;
                    _reduced = r ? 1 : 0;
                }
                return _reduced == 1;
            }
            set { _reduced = value ? 1 : 0; PlayerPrefs.SetInt("hawkes.reducedMotion", value ? 1 : 0); }
        }

        /// <summary>The slide length in seconds: clamped to 0.15-0.20, and exactly 0 with reduced motion.</summary>
        public static float Duration(float seconds, bool reduced) => reduced ? 0f : Mathf.Clamp(seconds, TransitionMin, TransitionMax);

        readonly Dictionary<RectTransform, Vector3> _rest = new Dictionary<RectTransform, Vector3>();
        readonly Dictionary<RectTransform, float> _lastPress = new Dictionary<RectTransform, float>();
        bool _busy;

        void Awake() { if (_instance == null) _instance = this; if (Sound == null) Sound = FindObjectOfType<HawkesSound>(); }

        Vector3 Rest(RectTransform rt) { if (!_rest.TryGetValue(rt, out var v)) { v = rt.localScale; _rest[rt] = v; } return v; }

        /// <summary>A control was pressed: pressed pop now, the ui click, one "ui-press" event. Call it once per press.</summary>
        public void Press(RectTransform rt, string label)
        {
            if (rt == null) return;
            // One entry per press: a handler wired twice in the same frame counts once.
            if (_lastPress.TryGetValue(rt, out var last) && Time.unscaledTime - last < 0.03f) return;
            _lastPress[rt] = Time.unscaledTime;
            float t0 = Time.realtimeSinceStartup;
            if (!ReducedMotion) StartCoroutine(Pop(rt));
            if (Sound == null) Sound = FindObjectOfType<HawkesSound>();
            if (Sound != null) Sound.PressUi();
            // The pop's first frame is this one: the pressed state is shown at once (reduced motion keeps a colour/brightness change to the game).
            HawkesUiRects.Press(label, true, (Time.realtimeSinceStartup - t0) * 1000f);
        }

        IEnumerator Pop(RectTransform rt)
        {
            var rest = Rest(rt);
            rt.localScale = rest * PressScale;
            yield return new WaitForSecondsRealtime(PressHold);
            if (rt != null) rt.localScale = rest;
        }

        /// <summary>Hover (pointer over) and focus (keyboard or controller) states: a small scale up that goes back on exit.</summary>
        public void Hover(RectTransform rt, bool on) { if (rt != null && !ReducedMotion) rt.localScale = Rest(rt) * (on ? HoverScale : 1f); }
        public void Focus(RectTransform rt, bool on) { if (rt != null && !ReducedMotion) rt.localScale = Rest(rt) * (on ? FocusScale : 1f); }

        /// <summary>Grows a control to at least 44 points each way (a small icon keeps its picture, the hit area grows).</summary>
        public void Fit(RectTransform rt)
        {
            if (rt == null) return;
            float ppp = HawkesUiRects.PixelsPerPoint > 0 ? HawkesUiRects.PixelsPerPoint : Mathf.Max(1f, Mathf.Min(Screen.width, Screen.height) / 390f);
            var corners = new Vector3[4]; rt.GetWorldCorners(corners);
            float w = (corners[2].x - corners[0].x) / ppp, h = (corners[2].y - corners[0].y) / ppp;
            var size = rt.sizeDelta;
            if (w < MinTarget && w > 0.01f) size.x *= MinTarget / w;
            if (h < MinTarget && h > 0.01f) size.y *= MinTarget / h;
            rt.sizeDelta = size;
        }

        /// <summary>Slides `next` in and `previous` out (dir 1 forward, -1 back): 150-200 ms, 0 ms with reduced motion. Logs one "ui-transition".</summary>
        public IEnumerator Show(CanvasGroup next, CanvasGroup previous = null, int dir = 1)
        {
            while (_busy) yield return null;
            _busy = true;
            bool reduced = ReducedMotion;
            float planned = Duration(TransitionSeconds, reduced);
            float t0 = Time.realtimeSinceStartup;
            var nrt = (RectTransform)next.transform;
            var prt = previous != null ? (RectTransform)previous.transform : null;
            var nHome = nrt.anchoredPosition; var pHome = prt != null ? prt.anchoredPosition : Vector2.zero;
            next.gameObject.SetActive(true);
            if (planned > 0f)
            {
                for (float t = 0f; t < planned; t += Time.unscaledDeltaTime)
                {
                    float k = 1f - Mathf.Pow(1f - Mathf.Clamp01(t / planned), 3f);
                    next.alpha = k; nrt.anchoredPosition = nHome + new Vector2(SlideDistance * dir * (1f - k), 0f);
                    if (previous != null) { previous.alpha = 1f - k; prt.anchoredPosition = pHome + new Vector2(-SlideDistance * dir * k, 0f); }
                    yield return null;
                }
            }
            next.alpha = 1f; nrt.anchoredPosition = nHome;
            if (previous != null) { previous.alpha = 1f; prt.anchoredPosition = pHome; previous.gameObject.SetActive(false); }
            float ms = planned <= 0f ? 0f : (Time.realtimeSinceStartup - t0) * 1000f;
            var run = HawkesPlaytest.Current;
            run?.Event("ui-transition", "{\"t\":" + F(Time.realtimeSinceStartup - (run?.StartTime ?? 0f)) + ",\"from\":\"" + (previous != null ? previous.name : "") + "\",\"to\":\"" + next.name
                + "\",\"ms\":" + F(ms) + ",\"plannedMs\":" + F(planned * 1000f) + ",\"reduced\":" + (reduced ? "true" : "false") + "}");
            _busy = false;
        }

        static string F(float v) => v.ToString("0.##", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Put this on a menu's root RectTransform: it fits the rect inside Screen.safeArea, and (while a playtest runs) inside the
    /// simulated iPhone notch and home bar too (47/34 pt portrait; 47 left and right, 21 bottom landscape), so no control sits under one.
    /// </summary>
    [RequireComponent(typeof(RectTransform))]
    public sealed class HawkesSafeArea : MonoBehaviour
    {
        public bool SimulateInPlaytest = true;
        Rect _applied; Vector2Int _size;

        /// <summary>The insets in screen pixels (left, bottom, right, top) for a screen: the device's safe area, widened to the simulated ones.</summary>
        public static Vector4 Insets(int w, int h, Rect safe, bool simulate)
        {
            float ppp = Mathf.Max(1f, Mathf.Min(w, h) / 390f);
            bool portrait = h >= w;
            float l = safe.xMin, b = safe.yMin, r = w - safe.xMax, t = h - safe.yMax;
            if (simulate)
            {
                l = Mathf.Max(l, (portrait ? 0 : 47) * ppp); r = Mathf.Max(r, (portrait ? 0 : 47) * ppp);
                t = Mathf.Max(t, (portrait ? 47 : 0) * ppp); b = Mathf.Max(b, (portrait ? 34 : 21) * ppp);
            }
            return new Vector4(l, b, r, t);
        }

        void Apply()
        {
            var rt = (RectTransform)transform;
            var i = Insets(Screen.width, Screen.height, Screen.safeArea, SimulateInPlaytest && HawkesPlaytest.Current != null);
            float w = Screen.width, h = Screen.height;
            rt.anchorMin = new Vector2(i.x / w, i.y / h);
            rt.anchorMax = new Vector2(1f - i.z / w, 1f - i.w / h);
            rt.offsetMin = rt.offsetMax = Vector2.zero;
            _applied = Screen.safeArea; _size = new Vector2Int(Screen.width, Screen.height);
        }

        void OnEnable() { Apply(); }
        // Only when the screen size, rotation or the device's safe area changed (a cheap compare, nothing is fetched).
        void Update() { if (Screen.safeArea != _applied || Screen.width != _size.x || Screen.height != _size.y) Apply(); }
    }
}
