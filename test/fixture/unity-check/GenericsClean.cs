using System;
using System.Collections.Generic;
using UObject = UnityEngine.Object;
using UnityEngine;

// Patterns from Sick of It's AddressablesOperationManager.cs: valid C# that the member scan once read as duplicates
// (CS0102 'List', 'Object', 'BoolCallbackList', 'UObject'). Nothing here may be reported.
public class BoolCallbackList : List<Action<bool>> { }

public class AddressablesOperationManager : MonoBehaviour
{
    private Dictionary<string, BoolCallbackList> pendingLabelLoadCallbacks = new Dictionary<string, BoolCallbackList>();
    private Dictionary<string, BoolCallbackList> pendingCatalogCallbacks = new Dictionary<string, BoolCallbackList>();
    private Dictionary<string, List<System.Action<bool>>> pendingSceneLoadCallbacks = new Dictionary<string, List<System.Action<bool>>>();
    private Dictionary<string, List<System.Action<bool>>> pendingUnloadCallbacks = new Dictionary<string, List<System.Action<bool>>>();
    private readonly Dictionary<string, Dictionary<string, UObject>> cache = new Dictionary<string, Dictionary<string, UObject>>(), spare = new Dictionary<string, Dictionary<string, UObject>>();
    private Func<string, UObject, bool> filter = (a, b) => a != null && b != null, other = null;
    private int total = 1, extra = 2;

    public void LoadAsset<T>(string address, System.Action<T> onComplete) where T : UnityEngine.Object
    {
        if (onComplete != null) onComplete(default(T));
    }

    public void LoadAsset<T>(string address, System.Action<T> onComplete, bool retry) where T : UObject
    {
        LoadAsset<T>(address, onComplete);
    }

    public void LoadAsset(string address, System.Action<UObject> onComplete)
    {
        LoadAsset<UObject>(address, onComplete);
    }

    public Dictionary<string, List<T>> Group<T, TKey>(IEnumerable<T> items, Func<T, TKey> key) where T : class where TKey : struct
    {
        return new Dictionary<string, List<T>>();
    }

    public TResult Convert<TSource, TResult>(TSource value) where TResult : class, new() => new TResult();

    public void Load<T>(string a) where T : class { }
    public void Load<T, U>(string a) where T : class where U : struct { }
    public void Load(string a) { }

    public bool Less(int a, int b, int c) { var x = a < b; return x && b > c; }
}
