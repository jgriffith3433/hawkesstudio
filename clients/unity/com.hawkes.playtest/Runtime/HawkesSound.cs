// The Hawkes sound kit for Unity (hawkesstudio/clients/web/hawkes-sound.js is its web twin; spec: docs/playtest.md#sound-kit).
// Drop it on one GameObject; games call it instead of AudioSource.PlayOneShot on raw clips.
//
//   var sound = gameObject.AddComponent<HawkesSound>();
//   sound.DefineSet("step-stone", HawkesSound.Bus.Sfx, clips);       // 3-5 variants
//   sound.Play("step-stone");                                         // random variant, never the same twice in a row, pitch within ±5%
//   sound.Speak("npc-greeting", clip);                                // voice bus; the music bus drops at least 6 dB and returns
//   sound.StartMusic(120f, 4, new[] { ("drums", drums), ("bass", bass) });
//   sound.SetStem("bass", true);                                      // takes effect on the next bar line (DSP-time scheduled)
//
// Buses are Music, Sfx, Ui, Voice and Ambience: each has a volume (BusVolume), and the music bus also has a duck. Every start is reported to the audio probe: on WebGL as a
// "hawkes-sound" window event (sound-start with sample, bus, rate, gain, dur; bus-gain when the duck moves) which
// hawkes-audio.js logs, on desktop as the playtest run's "sound-start" / "bus-gain" events. On WebGL the first tap,
// click or key resumes the browser's AudioContext (iOS Safari), play Ui presses with PressUi() from the button press
// handler (define a "ui-press" set of 3+ clicks first).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Hawkes.Playtest
{
    [DisallowMultipleComponent]
    public sealed class HawkesSound : MonoBehaviour
    {
        public enum Bus { Music, Sfx, Ui, Voice, Ambience }

        /// <summary>Pitch jitter is capped at ±5%: the sound-design criterion reads every event's pitch against its base.</summary>
        public const float MaxJitter = 0.05f;
        /// <summary>Music under voice drops at least this many dB (the audio probe's voice-duck limit is 6).</summary>
        public const float MinDuckDb = 6f;

        [Range(6f, 24f)] public float DuckDb = 9f;
        public float DuckAttack = 0.06f, DuckRelease = 0.5f;
        [Range(0f, 0.3f)] public float VolumeJitter = 0.1f;
        public float[] BusVolume = { 1f, 1f, 1f, 1f, 1f };

        sealed class VariantSet { public string Name; public Bus Bus; public AudioClip[] Clips; public float Pitch = 1f, Jitter = MaxJitter, Volume = 1f; public int Last = -1; }
        sealed class Stem { public string Name; public AudioSource Source; public float Level; }

        readonly Dictionary<string, VariantSet> _sets = new Dictionary<string, VariantSet>();
        readonly AudioSource[] _bus = new AudioSource[5];
        readonly List<Stem> _stems = new List<Stem>();
        System.Random _rng = new System.Random();
        int _voices;
        float _duck = 1f, _duckTarget = 1f;
        double _musicStart, _barLen;
        float _musicVolume = 0.8f;
        readonly List<(AudioSource src, float end)> _voiceEnds = new List<(AudioSource, float)>();

#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern void HawkesSound_Install();
        [DllImport("__Internal")] static extern void HawkesSound_Emit(string json);
#endif

        // ---- pure helpers (tested in the editor; same rules as hawkes-sound.js) ----

        /// <summary>Next variant: random, never the one just played when there is more than one.</summary>
        public static int PickVariant(int count, int last, System.Random rng)
        {
            if (count <= 1) return 0;
            int i = rng.Next(count - 1);
            if (last >= 0 && i >= last) i++;
            return Mathf.Clamp(i, 0, count - 1);
        }

        /// <summary>Playback pitch: base times a random ±jitter (capped at ±5%).</summary>
        public static float JitterPitch(float basePitch, float jitter, System.Random rng)
        {
            float j = Mathf.Clamp(jitter, 0f, MaxJitter);
            return basePitch * (1f + ((float)rng.NextDouble() * 2f - 1f) * j);
        }

        /// <summary>The time of the next bar line after `now` for a loop that started at `start`.</summary>
        public static double NextBar(double start, double barLen, double now)
            => start + Math.Max(1.0, Math.Ceiling((now - start) / barLen - 1e-9)) * barLen;

        // ---- setup ----

        void Awake()
        {
            for (int i = 0; i < _bus.Length; i++)
            {
                var go = new GameObject("HawkesSound." + (Bus)i);
                go.transform.SetParent(transform, false);
                _bus[i] = go.AddComponent<AudioSource>();
                _bus[i].playOnAwake = false;
                _bus[i].spatialBlend = 0f;
            }
#if UNITY_WEBGL && !UNITY_EDITOR
            try { HawkesSound_Install(); } catch { }
#endif
        }

        public void SetSeed(int seed) { _rng = new System.Random(seed); }

        public void DefineSet(string name, Bus bus, AudioClip[] clips, float pitch = 1f, float jitter = MaxJitter, float volume = 1f)
        {
            _sets[name] = new VariantSet { Name = name, Bus = bus, Clips = clips, Pitch = pitch, Jitter = Mathf.Clamp(jitter, 0f, MaxJitter), Volume = volume };
        }

        // ---- playing ----

        /// <summary>One variant of a set: no immediate repeat, ±5% pitch, small volume jitter. False if the set is unknown or empty.</summary>
        public bool Play(string name, float volume = 1f)
        {
            if (!_sets.TryGetValue(name, out var set) || set.Clips == null || set.Clips.Length == 0) return false;
            int i = PickVariant(set.Clips.Length, set.Last, _rng);
            set.Last = i;
            var clip = set.Clips[i];
            if (clip == null) return false;
            float pitch = JitterPitch(set.Pitch, set.Jitter, _rng);
            float vol = Mathf.Clamp(set.Volume * volume * (1f + ((float)_rng.NextDouble() * 2f - 1f) * VolumeJitter), 0f, 2f);
            var src = _bus[(int)set.Bus];
            src.pitch = pitch;   // PlayOneShot shares one pitch per source: the bus source carries it, so set it right before the shot
            src.PlayOneShot(clip, vol * BusVolume[(int)set.Bus]);
            Report(set.Name + "/" + (i + 1), set.Bus, pitch, vol, clip.length / Mathf.Max(0.01f, pitch));
            return true;
        }

        /// <summary>A press on the Ui bus (a button down): plays the "ui-press" set. Call it from the press, never the release.</summary>
        public bool PressUi() { return Play("ui-press"); }

        /// <summary>A voice line: plays on the Voice bus and ducks the music at least 6 dB until it ends.</summary>
        public void Speak(string name, AudioClip clip, float volume = 1f)
        {
            if (clip == null) return;
            _voices++;
            var src = _bus[(int)Bus.Voice];
            src.pitch = 1f;
            src.PlayOneShot(clip, volume * BusVolume[(int)Bus.Voice]);
            _voiceEnds.Add((src, Time.unscaledTime + clip.length));
            SetDuck(Mathf.Pow(10f, -Mathf.Max(MinDuckDb, DuckDb) / 20f));
            Report("voice/" + name, Bus.Voice, 1f, volume, clip.length);
        }

        void SetDuck(float target)
        {
            _duckTarget = target;
            Emit("{\"type\":\"bus-gain\",\"bus\":\"music\",\"gain\":" + F(target) + "}");
        }

        // ---- bar-synced music stems ----

        /// <summary>Starts every stem together on the DSP clock, looping; stems of one track must be a whole number of bars.</summary>
        public void StartMusic(float bpm, int beatsPerBar, (string name, AudioClip clip)[] stems, string[] on = null, float volume = 0.8f)
        {
            StopMusic();
            _barLen = 60.0 / bpm * beatsPerBar;
            _musicVolume = volume;
            _musicStart = AudioSettings.dspTime + 0.1;
            foreach (var (name, clip) in stems)
            {
                var go = new GameObject("HawkesSound.stem." + name);
                go.transform.SetParent(transform, false);
                var src = go.AddComponent<AudioSource>();
                src.clip = clip; src.loop = true; src.playOnAwake = false; src.spatialBlend = 0f;
                bool isOn = on == null || Array.IndexOf(on, name) >= 0;
                var stem = new Stem { Name = name, Source = src, Level = isOn ? volume : 0f };
                src.volume = stem.Level * _duck * BusVolume[(int)Bus.Music];
                src.PlayScheduled(_musicStart);
                _stems.Add(stem);
                Report("music/" + name, Bus.Music, 1f, stem.Level, clip.length);
            }
        }

        /// <summary>Bring a stem in or out on the next bar line. Returns the DSP time it takes effect.</summary>
        public double SetStem(string name, bool on)
        {
            var s = _stems.Find(x => x.Name == name);
            if (s == null) return -1;
            double at = NextBar(_musicStart, _barLen, AudioSettings.dspTime);
            _pending.Add((s, at, on ? _musicVolume : 0f));
            return at;
        }
        readonly List<(Stem s, double at, float vol)> _pending = new List<(Stem, double, float)>();

        public void StopMusic()
        {
            foreach (var s in _stems) if (s.Source != null) Destroy(s.Source.gameObject);
            _stems.Clear(); _pending.Clear();
        }

        void Update()
        {
            for (int i = _voiceEnds.Count - 1; i >= 0; i--)
            {
                if (Time.unscaledTime < _voiceEnds[i].end) continue;
                _voiceEnds.RemoveAt(i);
                if (--_voices <= 0) { _voices = 0; SetDuck(1f); }
            }
            float rate = _duckTarget < _duck ? 1f / Mathf.Max(0.01f, DuckAttack) : 1f / Mathf.Max(0.01f, DuckRelease);
            _duck = Mathf.MoveTowards(_duck, _duckTarget, rate * Time.unscaledDeltaTime);
            double now = AudioSettings.dspTime;
            for (int i = _pending.Count - 1; i >= 0; i--)
                if (now >= _pending[i].at) { _pending[i].s.Level = _pending[i].vol; _pending.RemoveAt(i); }
            // A stem's sound is its own level (changed on bar lines), times the music duck, times the music bus volume.
            foreach (var s in _stems)
                if (s.Source != null) s.Source.volume = s.Level * _duck * BusVolume[(int)Bus.Music];
        }

        // ---- reporting (what the audio probe reads) ----

        void Report(string sample, Bus bus, float rate, float gain, float dur)
        {
            string g = bus == Bus.Music ? F(_duck * gain) : F(gain);
            Emit("{\"type\":\"sound-start\",\"sample\":\"" + sample + "\",\"bus\":\"" + bus.ToString().ToLowerInvariant() + "\",\"rate\":" + F(rate) + ",\"gain\":" + g + ",\"dur\":" + F(dur) + "}");
        }

        static string F(float v) => v.ToString("0.####", CultureInfo.InvariantCulture);

        static void Emit(string json)
        {
#if UNITY_WEBGL && !UNITY_EDITOR
            try { HawkesSound_Emit(json); } catch { }
#else
            var run = HawkesPlaytest.Current;
            if (run == null || run.Done) return;
            try
            {
                int a = json.IndexOf("\"type\":\"", StringComparison.Ordinal) + 8;
                string type = json.Substring(a, json.IndexOf('"', a) - a);
                run.Event(type, json);
            }
            catch { }
#endif
        }
    }
}
