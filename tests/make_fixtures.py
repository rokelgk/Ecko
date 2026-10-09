"""Generate synthetic test artwork (run once; outputs are committed)."""
import os
import cv2
import numpy as np

HERE = os.path.join(os.path.dirname(__file__), "fixtures")


def logo():
    img = np.full((600, 800, 3), 255, np.uint8)
    cv2.circle(img, (250, 300), 200, (40, 40, 200), -1)       # red disc (BGR)
    cv2.circle(img, (250, 300), 200, (20, 20, 20), 14)         # black ring (satin)
    cv2.rectangle(img, (480, 120), (760, 480), (200, 120, 30), -1)  # blue block
    cv2.putText(img, "ECKO", (95, 330), cv2.FONT_HERSHEY_DUPLEX, 3.0, (255, 255, 255), 12, cv2.LINE_AA)
    cv2.line(img, (480, 540), (760, 540), (20, 20, 20), 3, cv2.LINE_AA)  # thin line
    return img


def transparent_star():
    img = np.zeros((400, 400, 4), np.uint8)
    pts = []
    for i in range(10):
        r = 180 if i % 2 == 0 else 75
        a = np.pi / 2 + i * np.pi / 5
        pts.append((200 + r * np.cos(a), 200 - r * np.sin(a)))
    cv2.fillPoly(img, [np.array(pts, np.int32)], (0, 200, 255, 255), cv2.LINE_AA)
    return img


if __name__ == "__main__":
    os.makedirs(HERE, exist_ok=True)
    cv2.imwrite(os.path.join(HERE, "logo.png"), logo())
    cv2.imwrite(os.path.join(HERE, "logo.jpg"), logo(), [cv2.IMWRITE_JPEG_QUALITY, 70])
    cv2.imwrite(os.path.join(HERE, "star.png"), transparent_star())
