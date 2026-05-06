#!/usr/bin/env python3

import rospy
import actionlib
from control_msgs.msg import FollowJointTrajectoryAction, FollowJointTrajectoryGoal
from trajectory_msgs.msg import JointTrajectoryPoint

# =========================
# JOINT POSITIONS
# =========================
HOME = [0.09, 0.61, -1.34, 0.09, -0.08, 0.08]
READ = [0.16, -0.34, -0.75, 0.16, -0.57, 0.09]
GRAB = [0.15, -0.61, -0.42, 0.03, -0.51, 0.12]
PATH = [1.15, 0.20, -0.66, 0.05, -0.47, 0.07]
BIN  = [1.75, -0.39, -0.12, -0.03, -0.74, 0.12]

JOINT_NAMES = [
    "joint_1",
    "joint_2",
    "joint_3",
    "joint_4",
    "joint_5",
    "joint_6"
]

class PickPlace:
    def __init__(self):
        rospy.init_node("simple_pick_place")

        self.client = actionlib.SimpleActionClient(
            "/niryo_robot_follow_joint_trajectory_controller/follow_joint_trajectory",
            FollowJointTrajectoryAction
        )

        rospy.loginfo("Waiting for trajectory controller...")
        self.client.wait_for_server()
        rospy.loginfo("Connected to controller")

    def move(self, joints, duration=3.0):
        goal = FollowJointTrajectoryGoal()

        goal.trajectory.joint_names = JOINT_NAMES

        point = JointTrajectoryPoint()
        point.positions = joints
        point.time_from_start = rospy.Duration(duration)

        goal.trajectory.points.append(point)

        self.client.send_goal(goal)
        self.client.wait_for_result()

    def run(self):
        rospy.loginfo("Moving to HOME")
        self.move(HOME)

        rospy.sleep(1)

        rospy.loginfo("Moving to READ")
        self.move(READ)

        rospy.sleep(1)

        rospy.loginfo("Moving to GRAB")
        self.move(GRAB)

        rospy.sleep(1)

        rospy.loginfo("Moving to PATH")
        self.move(PATH)

        rospy.sleep(1)

        rospy.loginfo("Moving to BIN")
        self.move(BIN)

        rospy.sleep(1)

        rospy.loginfo("Returning HOME")
        self.move(HOME)


if __name__ == "__main__":
    try:
        robot = PickPlace()
        robot.run()
    except rospy.ROSInterruptException:
        pass