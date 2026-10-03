#!/usr/bin/env python3
"""
Prime Number Generator

This script provides multiple methods for finding prime numbers:
1. Sieve of Eratosthenes (efficient for finding all primes up to n)
2. Trial division (efficient for checking individual numbers)
3. Generator-based approach (memory efficient for large ranges)

Usage:
    python prime_numbers.py <limit>
    
    Examples:
        python prime_numbers.py 100      # Find all primes up to 100
        python prime_numbers.py 1000     # Find all primes up to 1000
"""

import sys
import math
from typing import List, Generator


def sieve_of_eratosthenes(limit: int) -> List[int]:
    """
    Find all prime numbers up to limit using the Sieve of Eratosthenes.
    
    This is one of the most efficient ways to find all primes smaller than
    a given number, especially when you need to check multiple numbers.
    
    Args:
        limit: The upper bound (inclusive) for finding primes
        
    Returns:
        List of prime numbers up to limit
        
    Time Complexity: O(n log log n)
    Space Complexity: O(n)
    """
    if limit < 2:
        return []
    
    # Create a boolean array and initialize all entries as True
    is_prime = [True] * (limit + 1)
    is_prime[0] = is_prime[1] = False  # 0 and 1 are not prime
    
    # Start with the smallest prime number, 2
    p = 2
    while p * p <= limit:
        # If is_prime[p] is not changed, then it is a prime
        if is_prime[p]:
            # Mark all multiples of p as not prime
            # Start from p*p because smaller multiples of p are already marked
            for i in range(p * p, limit + 1, p):
                is_prime[i] = False
        p += 1
    
    # Collect all prime numbers
    primes = [i for i in range(2, limit + 1) if is_prime[i]]
    return primes


def is_prime_trial_division(n: int) -> bool:
    """
    Check if a single number is prime using trial division.
    
    Args:
        n: The number to check for primality
        
    Returns:
        True if n is prime, False otherwise
        
    Time Complexity: O(sqrt(n))
    """
    if n < 2:
        return False
    if n == 2:
        return True
    if n % 2 == 0:
        return False
    
    # Check odd divisors up to sqrt(n)
    for i in range(3, int(math.sqrt(n)) + 1, 2):
        if n % i == 0:
            return False
    return True


def generate_primes_up_to(limit: int) -> Generator[int, None, None]:
    """
    Generator that yields prime numbers up to limit.
    
    This is memory-efficient for large limits as it doesn't store
    all primes in memory at once.
    
    Args:
        limit: The upper bound (inclusive) for finding primes
        
    Yields:
        Prime numbers up to limit
    """
    for num in range(2, limit + 1):
        if is_prime_trial_division(num):
            yield num


def find_nth_prime(n: int) -> int:
    """
    Find the nth prime number.
    
    Args:
        n: Which prime to find (1-indexed)
        
    Returns:
        The nth prime number
        
    Raises:
        ValueError: If n is less than 1
    """
    if n < 1:
        raise ValueError("n must be a positive integer")
    
    count = 0
    num = 2
    
    while count < n:
        if is_prime_trial_division(num):
            count += 1
            if count == n:
                return num
        num += 1
    
    return num


def print_primes_in_columns(primes: List[int], columns: int = 10) -> None:
    """
    Print primes in a formatted grid.
    
    Args:
        primes: List of prime numbers to print
        columns: Number of primes per row
    """
    if not primes:
        print("No primes to display.")
        return
    
    for i, prime in enumerate(primes, 1):
        print(f"{prime:6d}", end="  ")
        if i % columns == 0:
            print()
    
    # Print newline if last row wasn't complete
    if len(primes) % columns != 0:
        print()


def main():
    """Main function to handle command-line arguments and run the program."""
    
    # Check if limit argument is provided
    if len(sys.argv) < 2:
        print("Usage: python prime_numbers.py <limit>")
        print("Example: python prime_numbers.py 100")
        sys.exit(1)
    
    try:
        limit = int(sys.argv[1])
        if limit < 0:
            print("Error: Limit must be a non-negative integer")
            sys.exit(1)
    except ValueError:
        print("Error: Please provide a valid integer as limit")
        sys.exit(1)
    
    print(f"Finding all prime numbers up to {limit}...\n")
    
    # Use Sieve of Eratosthenes for efficiency
    primes = sieve_of_eratosthenes(limit)
    
    # Display results
    print(f"Found {len(primes)} prime(s):\n")
    print_primes_in_columns(primes, columns=10)
    
    # Additional statistics
    print(f"\n{'='*50}")
    print(f"Statistics:")
    print(f"  Limit: {limit}")
    print(f"  Total primes found: {len(primes)}")
    if len(primes) > 0:
        print(f"  Largest prime: {primes[-1]}")
        print(f"  Smallest prime: {primes[0]}")
    
    # Example: Find the nth prime
    if limit >= 100:
        print(f"\nExample: The 100th prime is {find_nth_prime(100)}")


if __name__ == "__main__":
    main()
