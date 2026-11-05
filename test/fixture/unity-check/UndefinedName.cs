using UnityEngine;

// Modelled on Yooba Land web 29 (2026-11-05): YoobaThirdPersonCamera.cs used `dt` in LateUpdate, where only Update declares it.
public class UndefinedName : MonoBehaviour
{
    public Transform target;
    private float yaw;

    void Update()
    {
        float dt = Time.deltaTime;
        yaw += Input.GetAxis("Mouse X") * 120f * dt;
    }

    void LateUpdate()
    {
        var pos = target.position;
        pos.y += 1.5f * dt;
        transform.position = Vector3.Lerp(transform.position, pos, 8f * dt);
    }
}
