// The Hawkes story kit for Unity (hawkesstudio/clients/web/hawkes-story.js is its web twin; spec: docs/playtest.md#story-kit).
// Beats are data (beats.json, same shape as the web kit's; requirements are a flat all-of list here so JsonUtility reads them).
// Barks carry requirements, priority, cooldown and memory; cutscenes are skippable with voice, captions and music ducking
// (through HawkesSound); every beat is reported as a story event so quality.textOnlyBeats and quality.maxQuietSeconds are measured.
//
//   var story = gameObject.AddComponent<HawkesStory>();
//   story.Sound = sound;                       // the HawkesSound on the same object (voice bus, ducking); optional
//   story.Load(beatsJsonText);
//   story.SetFact("hp", 20);
//   story.Bark("hurt");                         // best eligible bark for the trigger; voice via HawkesSound.Speak with the clip from VoiceFor
//   StartCoroutine(story.Cutscene("wake"));     // captions in Screen.safeArea; a tap on Skip (>= 44 px) ends it
//
// Events (WebGL: window.__hawkesPlaytestPush through HawkesStory.jslib; desktop: the run's events): story-beat, story-cutscene,
// story-choice, story-activity, with the same fields as the web kit.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Hawkes.Playtest
{
    [DisallowMultipleComponent]
    public sealed class HawkesStory : MonoBehaviour
    {
        /// <summary>A bark may not come back sooner than this (Studio's repeat check is 5 minutes).</summary>
        public const float MinCooldownS = 300f;
        /// <summary>Cutscene Skip button minimum tap target, in pixels.</summary>
        public const float MinTapPx = 44f;

        [Serializable] public class Req { public string fact, op, seen, notSeen, flag; public float value; }
        [Serializable] public class BarkData { public string id, trigger, text, voice, speaker; public Req[] requires; public int priority; public float cooldown; public bool once; public string anim; }
        [Serializable] public class Line { public string text, voice, speaker; public float dur; }
        [Serializable] public class CutsceneData { public string id; public bool skippable = true; public Line[] lines; public string next; }
        [Serializable] public class Choice { public string text, to; }
        [Serializable] public class Page { public string id, text, voice, video, ending; public Choice[] choices; public string timeoutTo; public float timeoutSec; }
        [Serializable] public class Data { public string story; public BarkData[] barks = new BarkData[0]; public CutsceneData[] cutscenes = new CutsceneData[0]; public Page[] pages = new Page[0]; }

        public HawkesSound Sound;
        public Func<string, AudioClip> VoiceFor;   // voice url/id -> clip (Addressables, Resources...)
        public Data Beats = new Data();

        readonly Dictionary<string, float> _facts = new Dictionary<string, float>();
        readonly Dictionary<string, (int count, float last)> _said = new Dictionary<string, (int, float)>();
        string _caption = ""; float _captionUntil; bool _skip; bool _cutscene; bool _skippable;
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern void HawkesStory_Emit(string json);
#endif

        public void Load(string json) { Beats = JsonUtility.FromJson<Data>(json) ?? new Data(); }
        public void SetFact(string k, float v) { _facts[k] = v; }
        public bool Seen(string id) => _said.ContainsKey(id);
        public void Activity(string what = "activity") => Emit("{\"type\":\"story-activity\",\"what\":\"" + Esc(what) + "\",\"t\":" + F(Time.realtimeSinceStartup) + "}");

        // ---- pure rules (same as hawkes-story.js) ----
        public bool Meets(Req[] reqs)
        {
            if (reqs == null) return true;
            foreach (var r in reqs)
            {
                if (!string.IsNullOrEmpty(r.seen)) { if (!Seen(r.seen)) return false; continue; }
                if (!string.IsNullOrEmpty(r.notSeen)) { if (Seen(r.notSeen)) return false; continue; }
                if (!string.IsNullOrEmpty(r.flag)) { if (!_facts.TryGetValue(r.flag, out var fv) || fv == 0f) return false; continue; }
                if (string.IsNullOrEmpty(r.fact)) continue;
                _facts.TryGetValue(r.fact, out var v);
                switch (r.op)
                {
                    case "lt": if (!(v < r.value)) return false; break;
                    case "lte": if (!(v <= r.value)) return false; break;
                    case "gt": if (!(v > r.value)) return false; break;
                    case "gte": if (!(v >= r.value)) return false; break;
                    case "ne": if (Mathf.Approximately(v, r.value)) return false; break;
                    default: if (!Mathf.Approximately(v, r.value)) return false; break; // "eq" or none
                }
            }
            return true;
        }

        /// <summary>Highest priority eligible bark, not cooling down, not a spent once; ties go to the least recently said.</summary>
        public BarkData PickBark(string trigger, float now)
        {
            BarkData best = null; float bestLast = float.NegativeInfinity;
            foreach (var b in Beats.barks)
            {
                if (!string.IsNullOrEmpty(trigger) && b.trigger != trigger) continue;
                bool had = _said.TryGetValue(b.id, out var m);
                if (b.once && had) continue;
                if (had && now - m.last < Mathf.Max(MinCooldownS, b.cooldown)) continue;
                if (!Meets(b.requires)) continue;
                float last = had ? m.last : float.NegativeInfinity;
                if (best == null || b.priority > best.priority || (b.priority == best.priority && last < bestLast)) { best = b; bestLast = last; }
            }
            return best;
        }

        public BarkData Bark(string trigger)
        {
            float now = Time.realtimeSinceStartup;
            var b = PickBark(trigger, now);
            if (b == null) return null;
            bool voiced = false;
            if (!string.IsNullOrEmpty(b.voice) && Sound != null && VoiceFor != null)
            {
                var clip = VoiceFor(b.voice);
                if (clip != null) { Sound.Speak("bark-" + b.id, clip); voiced = true; }
            }
            ShowCaption(b.text, b.speaker, 3f + (b.text?.Length ?? 0) / 20f);
            Report("bark", b.id, voiced, !string.IsNullOrEmpty(b.anim), !string.IsNullOrEmpty(b.text), 0f, b.speaker);
            return b;
        }

        /// <summary>A cutscene as a coroutine: lines voiced and captioned, Skip one tap away. Yields until it ends or is skipped.</summary>
        public IEnumerator Cutscene(string id)
        {
            CutsceneData c = Array.Find(Beats.cutscenes, x => x.id == id);
            if (c == null) yield break;
            _cutscene = true; _skip = false; _skippable = c.skippable || Seen(id);
            Emit("{\"type\":\"story-cutscene\",\"id\":\"" + Esc(id) + "\",\"state\":\"start\",\"skippable\":" + (_skippable ? "true" : "false") + ",\"t\":" + F(Time.realtimeSinceStartup) + "}");
            bool voiced = false, captioned = false; float dur = 0f;
            foreach (var line in c.lines ?? new Line[0])
            {
                if (_skip) break;
                float len = Mathf.Max(1.5f, line.dur > 0 ? line.dur : (line.text?.Length ?? 0) / 14f);
                if (!string.IsNullOrEmpty(line.voice) && Sound != null && VoiceFor != null)
                {
                    var clip = VoiceFor(line.voice);
                    if (clip != null) { Sound.Speak(id + "-voice", clip); voiced = true; len = Mathf.Max(len, clip.length); }
                }
                captioned |= !string.IsNullOrEmpty(line.text);
                ShowCaption(line.text, line.speaker, len);
                dur += len;
                float end = Time.realtimeSinceStartup + len;
                while (!_skip && Time.realtimeSinceStartup < end) yield return null;
            }
            bool skipped = _skip;
            _cutscene = false; _caption = "";
            Report("cutscene", id, voiced, true, captioned, dur, null);
            Emit("{\"type\":\"story-cutscene\",\"id\":\"" + Esc(id) + "\",\"state\":\"" + (skipped ? "skip" : "end") + "\",\"via\":\"" + (skipped ? "tap" : "end") + "\",\"t\":" + F(Time.realtimeSinceStartup) + "}");
        }

        public void Skip() { if (_cutscene && _skippable) _skip = true; }

        /// <summary>Reports a page's choices (real when two or more different destinations) and the pick or the timeout default.</summary>
        public string Choose(string pageId, string picked = null)
        {
            Page p = Array.Find(Beats.pages, x => x.id == pageId);
            if (p == null) return null;
            var to = new HashSet<string>(); foreach (var c in p.choices ?? new Choice[0]) to.Add(c.to);
            string pick = picked ?? p.timeoutTo;
            Emit("{\"type\":\"story-choice\",\"id\":\"" + Esc(pageId) + "\",\"options\":" + to.Count + ",\"real\":" + (to.Count >= 2 ? "true" : "false") + ",\"timeout\":" + F(p.timeoutSec) + ",\"picked\":\"" + Esc(pick ?? "") + "\",\"t\":" + F(Time.realtimeSinceStartup) + "}");
            Report("choice", pageId, !string.IsNullOrEmpty(p.voice), !string.IsNullOrEmpty(p.video), !string.IsNullOrEmpty(p.text), 0f, null);
            return pick;
        }

        void ShowCaption(string text, string speaker, float secs)
        {
            _caption = string.IsNullOrEmpty(text) ? "" : (string.IsNullOrEmpty(speaker) ? text : speaker + ": " + text);
            _captionUntil = Time.realtimeSinceStartup + secs;
        }

        // Captions and the Skip button live inside Screen.safeArea (a notch never covers them); the button is at least MinTapPx.
        void OnGUI()
        {
            if (string.IsNullOrEmpty(_caption) && !_cutscene) return;
            if (!_cutscene && Time.realtimeSinceStartup > _captionUntil) { _caption = ""; return; }
            Rect safe = Screen.safeArea; // origin bottom-left; GUI is top-left
            float top = Screen.height - (safe.y + safe.height);
            float scale = Mathf.Max(1f, Screen.dpi / 160f);
            var style = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.LowerCenter, wordWrap = true, fontSize = Mathf.RoundToInt(18 * scale), fontStyle = FontStyle.Bold };
            style.normal.textColor = Color.white;
            float h = 110f * scale;
            GUI.Label(new Rect(safe.x + 12, top + safe.height - h - 72f * scale, safe.width - 24, h), _caption, style);
            if (_cutscene && _skippable)
            {
                float side = Mathf.Max(MinTapPx * scale, 52f);
                if (GUI.Button(new Rect(safe.x + safe.width - side * 1.6f - 12, top + 12, side * 1.6f, side), "Skip")) Skip();
            }
        }

        void Report(string kind, string id, bool voiced, bool acted, bool captioned, float dur, string speaker)
        {
            _said[id] = (_said.TryGetValue(id, out var m) ? m.count + 1 : 1, Time.realtimeSinceStartup);
            bool textOnly = !voiced && !acted && captioned;
            Emit("{\"type\":\"story-beat\",\"id\":\"" + Esc(id) + "\",\"kind\":\"" + kind + "\",\"voiced\":" + B(voiced) + ",\"acted\":" + B(acted) + ",\"captioned\":" + B(captioned) + ",\"textOnly\":" + B(textOnly) + ",\"dur\":" + F(dur) + ",\"t\":" + F(Time.realtimeSinceStartup) + "}");
        }

        static string B(bool v) => v ? "true" : "false";
        static string F(float v) => v.ToString("0.###", CultureInfo.InvariantCulture);
        static string Esc(string s) => (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");

        static void Emit(string json)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            try { HawkesStory_Emit(json); } catch { }
#else
            var run = HawkesPlaytest.Current;
            if (run == null || run.Done) return;
            try
            {
                int a = json.IndexOf("\"type\":\"", StringComparison.Ordinal) + 8;
                run.Event(json.Substring(a, json.IndexOf('"', a) - a), json);
            }
            catch { }
#endif
        }
    }
}
