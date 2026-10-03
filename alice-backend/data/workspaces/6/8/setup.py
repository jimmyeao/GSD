"""Setup script for the reminder application."""
from setuptools import setup, find_packages

setup(
    name="reminder-app",
    version="1.0.0",
    description="A Windows reminder application with MQTT integration to Home Assistant",
    author="Your Name",
    author_email="your.email@example.com",
    packages=find_packages(),
    install_requires=[
        "paho-mqtt>=1.6.0",
    ],
    extras_require={
        "gui": [
            "tkinter",
        ]
    },
    entry_points={
        "console_scripts": [
            "reminder-app=ReminderApp.main:main",
        ],
    },
    python_requires=">=3.8",
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: End Users/Desktop",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Operating System :: OS Independent",
    ],
)
