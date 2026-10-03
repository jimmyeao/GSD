"""GUI module for the reminder application."""
import tkinter as tk
from tkinter import ttk, messagebox
import threading
import time
from typing import Optional
from .mqtt_client import MQTTClient
from .reminder import Reminder


class ReminderAppGUI:
    """Graphical user interface for the reminder application."""
    
    def __init__(self, mqtt_client: MQTTClient):
        self.mqtt_client = mqtt_client
        self.root = tk.Tk()
        self.root.title("Reminder App")
        self.root.geometry("500x600")
        self.root.resizable(True, True)
        
        self.reminders: list[Reminder] = []
        self.current_reminder_id: Optional[str] = None
        
        self._setup_ui()
        self._setup_mqtt_callbacks()
    
    def _setup_ui(self):
        """Set up the user interface."""
        # Main frame
        main_frame = ttk.Frame(self.root, padding="10")
        main_frame.grid(row=0, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))
        
        # Configure grid weights
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        main_frame.columnconfigure(0, weight=1)
        main_frame.rowconfigure(4, weight=1)
        
        # Title
        title_label = ttk.Label(main_frame, text="Create Reminder", font=("Arial", 14, "bold"))
        title_label.grid(row=0, column=0, columnspan=2, pady=(0, 10))
        
        # Reminder title
        ttk.Label(main_frame, text="Title:").grid(row=1, column=0, sticky=tk.W, pady=(0, 5))
        self.title_entry = ttk.Entry(main_frame, width=40)
        self.title_entry.grid(row=1, column=1, sticky=(tk.W, tk.E), pady=(0, 5))
        
        # Reminder description
        ttk.Label(main_frame, text="Description:").grid(row=2, column=0, sticky=tk.NW, pady=(0, 5))
        self.description_text = tk.Text(main_frame, width=40, height=4)
        self.description_text.grid(row=2, column=1, sticky=(tk.W, tk.E), pady=(0, 5))
        
        # Priority
        ttk.Label(main_frame, text="Priority:").grid(row=3, column=0, sticky=tk.W, pady=(0, 5))
        self.priority_var = tk.IntVar(value=0)
        priority_frame = ttk.Frame(main_frame)
        priority_frame.grid(row=3, column=1, sticky=tk.W, pady=(0, 5))
        ttk.Radiobutton(priority_frame, text="Low", variable=self.priority_var, value=0).pack(side=tk.LEFT)
        ttk.Radiobutton(priority_frame, text="Medium", variable=self.priority_var, value=1).pack(side=tk.LEFT, padx=(10, 0))
        ttk.Radiobutton(priority_frame, text="High", variable=self.priority_var, value=2).pack(side=tk.LEFT, padx=(10, 0))
        
        # Buttons
        button_frame = ttk.Frame(main_frame)
        button_frame.grid(row=4, column=0, columnspan=2, pady=(10, 0))
        ttk.Button(button_frame, text="Add Reminder", command=self.add_reminder).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(button_frame, text="Clear", command=self.clear_fields).pack(side=tk.LEFT)
        
        # Reminders list
        ttk.Label(main_frame, text="Active Reminders:").grid(row=5, column=0, columnspan=2, sticky=tk.W, pady=(10, 5))
        
        self.reminder_listbox = tk.Listbox(main_frame, height=8, width=50)
        self.reminder_listbox.grid(row=6, column=0, columnspan=2, sticky=(tk.W, tk.E, tk.N, tk.S), pady=(0, 10))
        self.reminder_listbox.bind('<<ListboxSelect>>', self._on_reminder_select)
        
        # Scrollbar for listbox
        scrollbar = ttk.Scrollbar(main_frame, orient=tk.VERTICAL, command=self.reminder_listbox.yview)
        scrollbar.grid(row=6, column=2, sticky=(tk.N, tk.S))
        self.reminder_listbox.configure(yscrollcommand=scrollbar.set)
        
        # Action buttons
        action_frame = ttk.Frame(main_frame)
        action_frame.grid(row=7, column=0, columnspan=2, pady=(0, 10))
        ttk.Button(action_frame, text="Mark as Acknowledged", command=self.acknowledge_reminder).pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(action_frame, text="Delete", command=self.delete_reminder).pack(side=tk.LEFT)
    
    def _setup_mqtt_callbacks(self):
        """Set up MQTT callbacks."""
        def on_message(topic, payload):
            try:
                import json
                from .reminder import Reminder
                data = json.loads(payload.decode())
                reminder = Reminder.from_dict(data)
                self._add_reminder_to_list(reminder)
            except Exception as e:
                print(f"Error processing MQTT message: {e}")
        
        self.mqtt_client.set_callbacks(on_message=on_message)
    
    def add_reminder(self):
        """Add a new reminder."""
        title = self.title_entry.get().strip()
        description = self.description_text.get("1.0", tk.END).strip()
        
        if not title:
            messagebox.showwarning("Warning", "Please enter a title for the reminder!")
            return
        
        reminder = Reminder(
            title=title,
            description=description,
            timestamp=time.time(),
            priority=self.priority_var.get()
        )
        
        self._add_reminder_to_list(reminder)
        
        # Publish to MQTT
        self.mqtt_client.publish_reminder(
            reminder.reminder_id,
            reminder.title,
            reminder.description,
            reminder.timestamp,
            reminder.priority
        )
        
        self.clear_fields()
    
    def _add_reminder_to_list(self, reminder: Reminder):
        """Add a reminder to the listbox."""
        priority_str = ["Low", "Medium", "High"][reminder.priority]
        time_str = time.strftime("%Y-%m-%d %H:%M", time.localtime(reminder.timestamp))
        list_item = f"[{time_str}] {reminder.title} ({priority_str})"
        
        self.reminder_listbox.insert(tk.END, list_item)
        self.reminders.append(reminder)
    
    def clear_fields(self):
        """Clear the input fields."""
        self.title_entry.delete(0, tk.END)
        self.description_text.delete("1.0", tk.END)
        self.priority_var.set(0)
    
    def acknowledge_reminder(self):
        """Mark the selected reminder as acknowledged."""
        selection = self.reminder_listbox.curselection()
        if not selection:
            messagebox.showwarning("Warning", "Please select a reminder to acknowledge!")
            return
        
        index = selection[0]
        reminder = self.reminders[index]
        
        reminder.acknowledged = True
        self.mqtt_client.publish_acknowledgment(reminder.reminder_id)
        
        self.reminder_listbox.delete(index)
        self.reminders.pop(index)
    
    def delete_reminder(self):
        """Delete the selected reminder."""
        selection = self.reminder_listbox.curselection()
        if not selection:
            messagebox.showwarning("Warning", "Please select a reminder to delete!")
            return
        
        index = selection[0]
        self.reminder_listbox.delete(index)
        self.reminders.pop(index)
    
    def _on_reminder_select(self, event):
        """Handle reminder selection."""
        selection = self.reminder_listbox.curselection()
        if selection:
            self.current_reminder_id = self.reminders[selection[0]].reminder_id
    
    def run(self):
        """Run the GUI application."""
        self.root.mainloop()
