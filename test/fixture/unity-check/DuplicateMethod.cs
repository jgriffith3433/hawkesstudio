using UnityEngine;

public class Spawner : MonoBehaviour
{
    public int count;
    void Spawn(int n) { count += n; }
    void Update() { }
    void Spawn(int m) { count -= m; }
}
