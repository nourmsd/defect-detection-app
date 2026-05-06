import time
from pyniryo import NiryoRobot

# =========================
# CONNECTION
# =========================
robot = NiryoRobot("10.10.10.10")

# =========================
# JOINTS (YOUR VALUES)
# =========================
HOME = [0.09, 0.61, -1.34, 0.09, -0.08, 0.08]
READ = [0.16, -0.34, -0.75, 0.16, -0.57, 0.09]
GRAB = [0.15, -0.61, -0.42, 0.03, -0.51, 0.12]
PATH = [1.15, 0.20, -0.66, -0.05, -0.47, 0.07]
BIN = [1.75, -0.39, -0.12, -0.03, -0.74, 0.12]

# =========================
# INIT (CRITICAL STABILIZATION)
# =========================
print("Connecting...")

robot.calibrate_auto()
robot.update_tool()

time.sleep(2)   # 🔥 IMPORTANT FIX (prevents controller desync)

print("Robot ready ✔")

# =========================
# SAFE MOVE (WITH STABILIZATION)
# =========================
def move(label, joints):
    print(f"[MOVE] {label}")

    robot.move_joints(joints)

    # 🔥 CRITICAL FIX: allow controller to finish internal state
    time.sleep(1.0)

# =========================
# GRIPPER SAFE RESET
# =========================
def reset_gripper():
    robot.release_with_tool()
    time.sleep(0.3)

# =========================
# SAFE GRASP (NO OVERLOAD LOOP)
# =========================
def grasp():
    print("[GRIPPER] GRASP")

    reset_gripper()

    robot.grasp_with_tool()
    time.sleep(0.5)

    print("[GRIPPER] HOLD ✔")

# =========================
# EMERGENCY RECOVERY
# =========================
def recovery():
    print("⚠ RECOVERY")
    try:
        reset_gripper()
        robot.move_joints(HOME)
    except:
        print("Recovery failed")

# =========================
# MAIN FLOW (FIXED ORDER)
# =========================
try:
    print("=== START ===")

    move("HOME", HOME)

    move("READING", READ)

    # 🔥 IMPORTANT FIX: reset BEFORE next motion
    reset_gripper()
    time.sleep(0.5)

    move("GRAB", GRAB)

    grasp()

    move("PATH", PATH)
    move("BIN", BIN)

    reset_gripper()
    print("✔ RELEASED")

    move("RETURN", PATH)
    move("HOME", HOME)

    print("=== DONE ===")

except Exception as e:
    print(f"ERROR: {e}")
    recovery()