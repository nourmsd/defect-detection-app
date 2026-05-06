#!/usr/bin/env python3

import rospy
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint
import time

# =========================
# JOINTS (YOUR VALUES)
# =========================
HOME = [0.09, 0.61, -1.34, 0.09, -0.08, 0.08]
READ = [0.16, -0.34, -0.75, 0.16, -0.57, 0.09]
GRAB = [0.15, -0.61, -0.42, 0.03, -0.51, 0.12]
PATH = [1.15, 0.20, -0.66, -0.05, -0.47, 0.07]
BIN  = [1.75, -0.39, -0.12, -0.03, -0.74, 0.12]

# =========================
# ROS INIT
# =========================
rospy.init_node("pick_place_node")

pub = rospy.Publisher(
    "/niryo_robot_follow_joint_trajectory_controller/command",
    JointTrajectory,
    queue_size=10
)

rospy.sleep(2)

# =========================
# SEND JOINTS (ROS VERSION)
# =========================
def move(label, joints):
    print(f"[MOVE] {label}")

    msg = JointTrajectory()
    msg.joint_names = [
        "joint_1", "joint_2", "joint_3",
        "joint_4", "joint_5", "joint_6"
    ]

    point = JointTrajectoryPoint()
    point.positions = joints
    point.time_from_start = rospy.Duration(2.0)

    msg.points.append(point)

    pub.publish(msg)
    rospy.sleep(2)   # stabilization like your time.sleep(1)

# =========================
# GRIPPER (ROS VERSION)
# =========================
def release():
    # Niryo tool controller topic
    pub_tool.publish(False)   # depends on your driver setup
    rospy.sleep(0.3)

def grasp():
    print("[GRIPPER] GRASP")
    pub_tool.publish(True)
    rospy.sleep(0.5)

# =========================
# TOOL CONTROL (depends on driver)
# =========================
pub_tool = rospy.Publisher(
    "/niryo_robot_tools_commander/set_tool_actuation",
    rospy.msg.Bool,
    queue_size=10
)

rospy.sleep(1)

# =========================
# MAIN FLOW
# =========================
try:
    print("=== START ===")

    move("HOME", HOME)
    move("READ", READ)

    release()
    rospy.sleep(0.5)

    move("GRAB", GRAB)
    grasp()

    move("PATH", PATH)
    move("BIN", BIN)

    release()
    print("✔ RELEASED")

    move("PATH BACK", PATH)
    move("HOME", HOME)

    print("=== DONE ===")

except Exception as e:
    print("ERROR:", e)