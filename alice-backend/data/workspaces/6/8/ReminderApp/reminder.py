"""Reminder data model."""
import uuid
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Reminder:
    """Represents a reminder."""
    title: str
    description: str = ""
    timestamp: float = field(default_factory=time.time)
    priority: int = 0
    reminder_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    acknowledged: bool = False
    
    def to_dict(self) -> dict:
        """Convert reminder to dictionary."""
        return {
            "id": self.reminder_id,
            "title": self.title,
            "description": self.description,
            "timestamp": self.timestamp,
            "priority": self.priority,
            "acknowledged": self.acknowledged
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'Reminder':
        """Create a reminder from a dictionary."""
        return cls(
            id=data.get("id", str(uuid.uuid4())),
            title=data["title"],
            description=data.get("description", ""),
            timestamp=data.get("timestamp", time.time()),
            priority=data.get("priority", 0),
            acknowledged=data.get("acknowledged", False)
        )
