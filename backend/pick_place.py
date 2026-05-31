from pyniryo import NiryoRobot, PoseObject
import time
ROBOT_IP = "10.10.10.10"  
INSPECTION_POSE = PoseObject(
    x=0.244, y=0.022, z=0.191,
    roll=-2.796, pitch=1.463, yaw=-2.891
)

PICK_POSE = PoseObject(
    x=0.295, y=0.05, z=0.137,
    roll=-3.036, pitch=1.525, yaw=-3.087
)

INTER_POSE1 = PoseObject(
    x=0.228, y=0.039, z=0.241, 
    roll=2.916, pitch=1.505, yaw=2.951
)

INTER_POSE2 = PoseObject(
    x=-0.004, y=0.255, z=0.285, 
    roll=-0.43, pitch=1.428, yaw=1.082
)

REJECT_BIN_POSE = PoseObject(
    x=-0.036, y=0.365, z=0.177, 
    roll=-0.055, pitch=1.407, yaw=1.521
)
def reset_gripper(robot):
    """Resets the tool connection to fix stalling/partial opening."""
    print("[FIX] Resetting Gripper connection...")
    robot.update_tool() 
    time.sleep(1.0)
    robot.open_gripper(speed=500) 
    print("[FIX] Gripper recalibrated.")
def perform_reject_action(robot):
    print("[ROBOT] Starting Pick & Place for Reject...")
    reset_gripper(robot)
    print("Moving to PICK_POSE...")
    robot.move_pose(PICK_POSE)
    time.sleep(0.5)
    print("Grasping...")
    robot.grasp_with_tool()
    time.sleep(0.5) 
    print("Moving through intermediate poses...")
    robot.move_pose(INTER_POSE1)
    robot.move_pose(INTER_POSE2)
    print("Moving to REJECT_BIN_POSE...")
    robot.move_pose(REJECT_BIN_POSE)
    robot.release_with_tool()
    robot.open_gripper(speed=500)
    time.sleep(0.5)
    print("Returning to inspection pose...")
    robot.move_pose(INTER_POSE2)
    robot.move_pose(INTER_POSE1)
    robot.move_pose(INSPECTION_POSE)
    
    print("[ROBOT] Test Cycle Complete.")
if __name__ == "__main__":
    try:
        print(f"Connecting to robot at {ROBOT_IP}...")
        robot = NiryoRobot(ROBOT_IP)
        print("Calibrating...")
        robot.calibrate_auto()
        robot.update_tool()
        print("Moving to initial Inspection Pose...")
        robot.move_pose(INSPECTION_POSE)
        perform_reject_action(robot)
        
    except Exception as e:
        print(f"An error occurred: {e}")
    finally:
        if 'robot' in locals():
            robot.close_connection()
            print("Connection closed.")