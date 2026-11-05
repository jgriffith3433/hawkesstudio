using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

// Every construct here is valid and must not be reported as an undefined name.
namespace Game.Names
{
    public enum Mode { idle, run }

    public class NamesClean : MonoBehaviour
    {
        private float speed, drag = 2f;
        private int count;
        public int level { get; private set; }
        public event Action<int> changed;
        private List<float> samples = new List<float>();

        void Awake()
        {
            var cam = Camera.main;
            if (cam != null && enabled) name = "x";
            gameObject.tag = tag;
        }

        void Update(float dt)
        {
            foreach (var s in samples) speed += s * dt;
            for (int i = 0; i < count; i++) speed -= drag * i;
            if (TryGet(out var found) && found > 1) speed = found;
            if (TryGet(out int other)) speed += other;
            Func<float, float> twice = v => v * 2f;
            Func<float, float, float> add = (a, b) => a + b;
            speed = add(twice(speed), dt);
            var q = samples.Where(x => x > speed).Select(x => x * drag).ToList();
            try { count++; } catch (Exception ex) { Debug.Log(ex.Message); }
            object o = speed;
            if (o is float f && f > 0) speed = f;
            var pair = (first: 1, second: 2);
            Debug.Log(pair.first + pair.second);
            int a1 = 1, b1 = 2;
            speed += a1 + b1;
            Dictionary<string, int> map = new Dictionary<string, int>();
            foreach (var kv in map) count += kv.Value;
            int? maybe = 3;
            speed += maybe ?? 0;
            var init = new Vector3 { x = 1, y = 2 };
            Foo(min: 0, max: 1);
            level = count > 2 ? count : 0;
            changed?.Invoke(level);
            void Local(int z) { speed += z; }
            Local(2);
        }

        bool TryGet(out int v) { v = 1; return true; }
        void Foo(int min, int max) { speed = min + max; }
        public int Level { set { level = value; } }
    }

    public class Derived : Base
    {
        void Tick() { speed2 = 1; }
    }
}
