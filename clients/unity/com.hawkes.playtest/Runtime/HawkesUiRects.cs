// The playtest UI reporter for Unity (hawkesstudio/docs/playtest.md#ui; the rubric's menus-and-ui rule): canvas and uGUI games
// have no DOM, so the game says where its controls are and when one was pressed. Studio turns that into ui.* metrics and
// findings (small targets, controls under the notch or home bar, offscreen, dead and silent presses), the same as for web games.
//
//   // when a menu opens (and after a rotation): every control's rect on screen
//   HawkesUiRects.Report(new[] {
//       HawkesUiRects.Control("Play", playButton.GetComponent<RectTransform>()),
//       HawkesUiRects.Control("Options", optionsRt),
//   });
//   // when a control is pressed: did the screen answer? (a pressed state, a transition: set changed=false when nothing moved)
//   HawkesUiRects.Press("Play", changed: true);
//
// A control's size is judged in points (44 px minimum, 8 px between neighbours): pixels are divided by PixelsPerPoint, which
// defaults to the screen's short side over 390 (a phone is 390 points wide in portrait; 844x390 in landscape).
// Insets are the simulated iPhone ones (notch 47, home bar 34 portrait; 47 left/right and 21 bottom landscape) together with
// Screen.safeArea when the device reports one. Sound is checked by Studio from the audio probe's events, not here.
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace Hawkes.Playtest
{
    public static class HawkesUiRects
    {
        public const float MinTarget = 44f, MinGap = 8f, VisualMs = 100f;

        public struct UiControl
        {
            public string Id, Label;
            /// <summary>Screen pixels, origin at the bottom left (Unity's screen space).</summary>
            public Rect Screen;
        }

        public static float PixelsPerPoint = 0f; // 0: the screen's short side / 390

        /// <summary>A control from a RectTransform (Screen Space Overlay, or Camera: pass the canvas camera).</summary>
        public static UiControl Control(string label, RectTransform rt, Camera camera = null)
        {
            var c = new Vector3[4];
            rt.GetWorldCorners(c);
            float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
            foreach (var w in c)
            {
                var s = camera != null ? (Vector3)camera.WorldToScreenPoint(w) : w;
                x0 = Mathf.Min(x0, s.x); y0 = Mathf.Min(y0, s.y); x1 = Mathf.Max(x1, s.x); y1 = Mathf.Max(y1, s.y);
            }
            return new UiControl { Id = rt.name + "|" + label, Label = label, Screen = Rect.MinMaxRect(x0, y0, x1, y1) };
        }

        /// <summary>One layout check of the controls on screen now: pushes a "ui-layout" event to the current playtest run.</summary>
        public static string Report(IEnumerable<UiControl> controls, string scene = null)
        {
            var run = HawkesPlaytest.Current;
            float w = Screen.width, h = Screen.height;
            bool portrait = h >= w;
            float ppp = PixelsPerPoint > 0 ? PixelsPerPoint : Mathf.Max(1f, Mathf.Min(w, h) / 390f);
            // Insets in points: the simulated ones, widened by the device's own safe area.
            float top = portrait ? 47 : 0, bottom = portrait ? 34 : 21, left = portrait ? 0 : 47, right = portrait ? 0 : 47;
            var sa = Screen.safeArea;
            top = Mathf.Max(top, (h - sa.yMax) / ppp); bottom = Mathf.Max(bottom, sa.yMin / ppp);
            left = Mathf.Max(left, sa.xMin / ppp); right = Mathf.Max(right, (w - sa.xMax) / ppp);
            float W = w / ppp, H = h / ppp;

            var list = new List<(string id, string label, float x, float y, float cw, float ch)>();
            foreach (var c in controls)
                list.Add((c.Id, c.Label, c.Screen.xMin / ppp, H - c.Screen.yMax / ppp, c.Screen.width / ppp, c.Screen.height / ppp)); // y down

            var issues = new StringBuilder();
            int n = 0;
            void Issue(string kind, (string id, string label, float x, float y, float cw, float ch) c, string detail)
            {
                if (n++ > 0) issues.Append(',');
                issues.Append("{\"kind\":").Append(Q(kind)).Append(",\"id\":").Append(Q(c.id)).Append(",\"label\":").Append(Q(c.label))
                      .Append(",\"rect\":[").Append(F(c.x)).Append(',').Append(F(c.y)).Append(',').Append(F(c.cw)).Append(',').Append(F(c.ch))
                      .Append("],\"detail\":").Append(Q(detail)).Append('}');
            }
            foreach (var c in list)
            {
                float r = c.x + c.cw, b = c.y + c.ch;
                if (c.x < -1 || r > W + 1 || c.y < -1 || b > H + 1) { Issue("offscreen", c, "runs off the " + W.ToString("0") + "x" + H.ToString("0") + " screen"); continue; }
                if (c.cw < MinTarget || c.ch < MinTarget) Issue("small", c, "is " + F(c.cw) + "x" + F(c.ch) + " px, under the 44 px minimum");
                var hit = new List<string>();
                if (c.y < top) hit.Add("the notch"); if (b > H - bottom) hit.Add("the home bar");
                if (c.x < left) hit.Add("the left inset"); if (r > W - right) hit.Add("the right inset");
                if (hit.Count > 0) Issue("inset", c, "sits under " + string.Join(" and ", hit));
            }
            for (int i = 0; i < list.Count; i++)
                for (int j = i + 1; j < list.Count; j++)
                {
                    var a = list[i]; var b2 = list[j];
                    float gx = Mathf.Max(b2.x - (a.x + a.cw), a.x - (b2.x + b2.cw)), gy = Mathf.Max(b2.y - (a.y + a.ch), a.y - (b2.y + b2.ch));
                    float gap = Mathf.Max(gx, gy);
                    if (gap > 0 && gap < MinGap && Mathf.Min(gx, gy) < 0) Issue("spacing", a, "is " + F(gap) + " px from \"" + b2.label + "\"");
                }
            var json = "{\"orientation\":\"" + (portrait ? "portrait" : "landscape") + "\",\"viewport\":[" + F(W) + "," + F(H) + "],\"scene\":" + Q(scene ?? run?.CurrentScene ?? "")
                     + ",\"controls\":" + list.Count + ",\"source\":\"unity\",\"issues\":[" + issues + "]}";
            run?.Event("ui-layout", json);
            return json;
        }

        /// <summary>A control was pressed. changed: the screen answered (a pressed state, a transition); ms: how fast (null: not measured).</summary>
        public static void Press(string label, bool changed = true, float? ms = null)
        {
            var run = HawkesPlaytest.Current;
            if (run == null) return;
            bool visual = changed && (ms == null || ms <= VisualMs);
            var t = Time.realtimeSinceStartup - run.StartTime;
            run.Event("ui-press", "{\"t\":" + F(t) + ",\"id\":" + Q("ui|" + label) + ",\"label\":" + Q(label) + ",\"scene\":" + Q(run.CurrentScene ?? "")
                + ",\"orientation\":\"" + (Screen.height >= Screen.width ? "portrait" : "landscape") + "\",\"visual\":" + (visual ? "true" : "false")
                + ",\"visualMs\":" + (ms.HasValue ? F(ms.Value) : "null") + "}");
        }

        static string F(float v) => v.ToString("0.##", CultureInfo.InvariantCulture);
        static string Q(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (var ch in s ?? "") { if (ch == '"' || ch == '\\') sb.Append('\\'); if (ch < 32) continue; sb.Append(ch); }
            return sb.Append('"').ToString();
        }
    }
}
