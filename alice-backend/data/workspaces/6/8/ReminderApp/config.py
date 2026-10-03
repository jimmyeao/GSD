"""Configuration module for the reminder application."""
import configparser
import os
from pathlib import Path
from typing import Optional


class Config:
    """Configuration manager for the reminder app."""
    
    DEFAULT_CONFIG = {
        "mqtt": {
            "broker": "localhost",
            "port": "1883",
            "username": "",
            "password": "",
            "client_id": "reminder_app",
            "base_topic": "reminder"
        },
        "app": {
            "window_width": "500",
            "window_height": "600"
        }
    }
    
    def __init__(self, config_path: Optional[str] = None):
        self.config_path = config_path or self._get_default_config_path()
        self.config = configparser.ConfigParser()
        self._load_config()
    
    def _get_default_config_path(self) -> str:
        """Get the default configuration file path."""
        app_dir = Path.home() / ".reminder_app"
        app_dir.mkdir(exist_ok=True)
        return str(app_dir / "config.ini")
    
    def _load_config(self):
        """Load configuration from file."""
        # Set defaults
        for section, options in self.DEFAULT_CONFIG.items():
            self.config[section] = options
        
        # Load from file if exists
        if os.path.exists(self.config_path):
            self.config.read(self.config_path)
    
    def save(self):
        """Save configuration to file."""
        with open(self.config_path, 'w') as f:
            self.config.write(f)
    
    @property
    def mqtt_broker(self) -> str:
        return self.config.get("mqtt", "broker", fallback="localhost")
    
    @property
    def mqtt_port(self) -> int:
        return self.config.getint("mqtt", "port", fallback=1883)
    
    @property
    def mqtt_username(self) -> Optional[str]:
        username = self.config.get("mqtt", "username", fallback="")
        return username if username else None
    
    @property
    def mqtt_password(self) -> Optional[str]:
        password = self.config.get("mqtt", "password", fallback="")
        return password if password else None
    
    @property
    def mqtt_client_id(self) -> str:
        return self.config.get("mqtt", "client_id", fallback="reminder_app")
    
    @property
    def mqtt_base_topic(self) -> str:
        return self.config.get("mqtt", "base_topic", fallback="reminder")
    
    @property
    def window_width(self) -> int:
        return self.config.getint("app", "window_width", fallback=500)
    
    @property
    def window_height(self) -> int:
        return self.config.getint("app", "window_height", fallback=600)
