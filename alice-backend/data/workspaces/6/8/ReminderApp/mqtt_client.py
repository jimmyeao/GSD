"""MQTT client module for communicating with Home Assistant."""
import paho.mqtt.client as mqtt
import json
import logging
from typing import Optional, Callable

logger = logging.getLogger(__name__)


class MQTTClient:
    """MQTT client for Home Assistant integration."""
    
    def __init__(
        self,
        broker: str = "localhost",
        port: int = 1883,
        username: Optional[str] = None,
        password: Optional[str] = None,
        client_id: str = "reminder_app",
        base_topic: str = "reminder"
    ):
        self.broker = broker
        self.port = port
        self.username = username
        self.password = password
        self.client_id = client_id
        self.base_topic = base_topic.rstrip('/')
        
        self.client: Optional[mqtt.Client] = None
        self._on_connect_callback: Optional[Callable] = None
        self._on_message_callback: Optional[Callable] = None
    
    def connect(self) -> bool:
        """Connect to the MQTT broker."""
        try:
            self.client = mqtt.Client(client_id=self.client_id)
            
            if self.username and self.password:
                self.client.username_pw_set(self.username, self.password)
            
            self.client.on_connect = self._on_connect
            self.client.on_message = self._on_message
            self.client.on_disconnect = self._on_disconnect
            
            self.client.connect(self.broker, self.port, keepalive=60)
            self.client.loop_start()
            
            logger.info(f"Connected to MQTT broker at {self.broker}:{self.port}")
            return True
        except Exception as e:
            logger.error(f"Failed to connect to MQTT broker: {e}")
            return False
    
    def disconnect(self):
        """Disconnect from the MQTT broker."""
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()
            logger.info("Disconnected from MQTT broker")
    
    def _on_connect(self, client, userdata, flags, rc):
        """Callback for when connected to broker."""
        if rc == 0:
            logger.info("MQTT connection established")
            if self._on_connect_callback:
                self._on_connect_callback()
        else:
            logger.error(f"MQTT connection failed with code {rc}")
    
    def _on_disconnect(self, client, userdata, rc):
        """Callback for disconnection."""
        logger.info(f"MQTT disconnected with code {rc}")
    
    def _on_message(self, client, userdata, msg):
        """Callback for received messages."""
        logger.debug(f"Received message on topic {msg.topic}: {msg.payload}")
        if self._on_message_callback:
            self._on_message_callback(msg.topic, msg.payload)
    
    def set_callbacks(self, on_connect: Optional[Callable] = None, on_message: Optional[Callable] = None):
        """Set callback functions."""
        self._on_connect_callback = on_connect
        self._on_message_callback = on_message
    
    def publish_reminder(self, reminder_id: str, title: str, description: str, timestamp: float, priority: int = 0):
        """Publish a reminder to Home Assistant."""
        if not self.client or not self.client.is_connected():
            logger.error("MQTT client not connected")
            return False
        
        topic = f"{self.base_topic}/reminder"
        payload = {
            "id": reminder_id,
            "title": title,
            "description": description,
            "timestamp": timestamp,
            "priority": priority,
            "status": "pending"
        }
        
        try:
            self.client.publish(topic, json.dumps(payload), qos=1)
            logger.info(f"Published reminder: {title}")
            return True
        except Exception as e:
            logger.error(f"Failed to publish reminder: {e}")
            return False
    
    def publish_acknowledgment(self, reminder_id: str):
        """Publish an acknowledgment for a reminder."""
        topic = f"{self.base_topic}/ack/{reminder_id}"
        payload = {"status": "acknowledged", "timestamp": float('inf')}
        
        if self.client and self.client.is_connected():
            try:
                self.client.publish(topic, json.dumps(payload), qos=1)
                logger.info(f"Acknowledged reminder: {reminder_id}")
            except Exception as e:
                logger.error(f"Failed to publish acknowledgment: {e}")
