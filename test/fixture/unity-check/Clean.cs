using System.Collections.Generic;
using UnityEngine;

namespace Game.Core
{
    [RequireComponent(typeof(Rigidbody))]
    public class Clean : MonoBehaviour
    {
        public int Health { get; set; } = 10;
        private readonly Dictionary<string, int> scores = new Dictionary<string, int>();
        public event System.Action Died;
        private string path = @"C:\Games\Yooba\";
        private char slash = '\\';
        private char quote = '\'';

        void Start() { Debug.Log($"hp {Health} {{ok}} {(Health > 5 ? "high" : "low")}"); }
        public void Hit(int amount) { Health -= amount; if (Health <= 0) Died?.Invoke(); }
        public void Hit(float amount) { Hit((int)amount); }
        public void Hit(int amount, string by) { Hit(amount); }
        public int Count() => scores.Count;
        string text = "She said \"hi\" and C:\\dir\\";
#if UNITY_EDITOR
        void Editor() { }
#else
        void Editor() { }
#endif
        partial void OnHit();
    }
}
